// Ticket operations shared by the inbox API, Gmail sync and rules: status, tags, assignment,
// activity log, merging, and the support rules engine (Redo "Rules").
import type { Env } from "../env";
import { getSetting, nowIso } from "./util";

export const STATUSES = ["open", "in_progress", "snoozed", "closed", "archived", "spam", "deleted"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** Statuses that count as "still needs work" and reopen on a customer reply. */
export const ACTIVE: Status[] = ["open", "in_progress", "snoozed"];

export interface SupportSettings {
  assignment: "manual" | "round_robin" | "balanced";
  autoMerge: boolean; // merge a customer's new email into their open ticket from the last 24 h
  mergeExclusions: string[]; // emails or @domains that always start a new ticket
  closeOnGmailArchive: boolean;
  afterClose: "next" | "list" | "stay";
  undoSendSeconds: number;
  aiAutoInsights: boolean; // summarise every new customer message (costs per message)
}
export const DEFAULT_SUPPORT: SupportSettings = {
  assignment: "manual",
  autoMerge: true,
  mergeExclusions: [],
  closeOnGmailArchive: true,
  afterClose: "next",
  undoSendSeconds: 5,
  aiAutoInsights: false,
};
export const supportSettings = async (env: Env): Promise<SupportSettings> => ({
  ...DEFAULT_SUPPORT,
  ...(await getSetting<Partial<SupportSettings>>(env, "support", {})),
});

export interface TicketRow {
  id: number;
  subject: string;
  customer_email: string;
  customer_name: string | null;
  status: Status;
  priority: string | null;
  assignee_id: number | null;
  tags: string;
  message_count: number;
  gmail_thread_id: string | null;
}

export const parseTags = (raw: string | null | undefined): string[] => {
  try {
    const t = JSON.parse(raw || "[]");
    return Array.isArray(t) ? t.map(String) : [];
  } catch {
    return [];
  }
};

export async function logEvent(env: Env, ticketId: number, kind: string, detail = "", agentId: number | null = null) {
  await env.DB.prepare("INSERT INTO events (ticket_id, agent_id, kind, detail) VALUES (?, ?, ?, ?)").bind(ticketId, agentId, kind, detail).run();
}

export async function getTicket(env: Env, id: number) {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<TicketRow>();
}

export async function setStatus(env: Env, t: TicketRow, status: Status, agentId: number | null, opts: { snoozeUntil?: string | null; source?: string } = {}) {
  if (!STATUSES.includes(status)) throw new Error("Unknown status");
  if (t.status === status && status !== "snoozed") return false;
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE tickets SET status = ?, snoozed_until = ?,
       closed_at = CASE WHEN ? IN ('closed','archived') THEN ? ELSE NULL END,
       resolved_at = CASE WHEN ? = 'closed' THEN COALESCE(resolved_at, ?) WHEN ? = 'open' THEN NULL ELSE resolved_at END
     WHERE id = ?`,
  )
    .bind(status, status === "snoozed" ? opts.snoozeUntil ?? null : null, status, now, status, now, status, t.id)
    .run();
  await logEvent(env, t.id, "status", opts.source ? `${status}|${opts.source}` : status, agentId);
  t.status = status;
  return true;
}

export async function setTags(env: Env, t: TicketRow, next: string[], agentId: number | null) {
  const before = parseTags(t.tags);
  const clean = [...new Set(next.map((s) => s.trim()).filter(Boolean))].slice(0, 40);
  const added = clean.filter((x) => !before.some((b) => b.toLowerCase() === x.toLowerCase()));
  const removed = before.filter((x) => !clean.some((c) => c.toLowerCase() === x.toLowerCase()));
  if (!added.length && !removed.length) return;
  await env.DB.prepare("UPDATE tickets SET tags = ? WHERE id = ?").bind(JSON.stringify(clean), t.id).run();
  // Unknown tags join the "General" group so they appear in pickers and filters
  for (const name of added) await env.DB.prepare("INSERT OR IGNORE INTO tags (name, group_name) VALUES (?, 'General')").bind(name).run();
  if (added.length) await logEvent(env, t.id, "tag_added", added.join(", "), agentId);
  if (removed.length) await logEvent(env, t.id, "tag_removed", removed.join(", "), agentId);
  t.tags = JSON.stringify(clean);
}

export async function assign(env: Env, t: TicketRow, assigneeId: number | null, actorId: number | null) {
  if (t.assignee_id === assigneeId) return;
  let name = "nobody";
  if (assigneeId !== null) {
    const a = await env.DB.prepare("SELECT name FROM agents WHERE id = ? AND active = 1").bind(assigneeId).first<{ name: string }>();
    if (!a) throw new Error("Unknown agent");
    name = a.name;
  }
  await env.DB.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").bind(assigneeId, t.id).run();
  await logEvent(env, t.id, "assigned", name, actorId);
  t.assignee_id = assigneeId;
}

/** Round robin = least recently assigned available agent; balanced = fewest active tickets. */
export async function pickAssignee(env: Env, mode: SupportSettings["assignment"]): Promise<number | null> {
  if (mode === "manual") return null;
  if (mode === "balanced") {
    const r = await env.DB.prepare(
      `SELECT a.id FROM agents a LEFT JOIN tickets t ON t.assignee_id = a.id AND t.status IN ('open','in_progress')
       WHERE a.active = 1 AND a.available = 1 GROUP BY a.id ORDER BY COUNT(t.id), a.id LIMIT 1`,
    ).first<{ id: number }>();
    return r?.id ?? null;
  }
  // Round robin: the available agent whose most recent assigned ticket is oldest
  const r = await env.DB.prepare(
    `SELECT a.id FROM agents a WHERE a.active = 1 AND a.available = 1
     ORDER BY COALESCE((SELECT MAX(t.created_at) FROM tickets t WHERE t.assignee_id = a.id), '') ASC, a.id LIMIT 1`,
  ).first<{ id: number }>();
  return r?.id ?? null;
}

/** Moves everything from `from` into `into`: messages, notes, events, Gmail threads. */
export async function mergeTickets(env: Env, from: TicketRow, into: TicketRow, agentId: number | null) {
  if (from.id === into.id) return;
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET ticket_id = ? WHERE ticket_id = ?").bind(into.id, from.id),
    env.DB.prepare("UPDATE notes SET ticket_id = ? WHERE ticket_id = ?").bind(into.id, from.id),
    env.DB.prepare("UPDATE ticket_threads SET ticket_id = ? WHERE ticket_id = ?").bind(into.id, from.id),
    env.DB.prepare("UPDATE mentions SET ticket_id = ? WHERE ticket_id = ?").bind(into.id, from.id),
    env.DB.prepare(
      `UPDATE tickets SET
         message_count = (SELECT COUNT(*) FROM messages WHERE ticket_id = ?1),
         last_message_at = (SELECT MAX(sent_at) FROM messages WHERE ticket_id = ?1),
         last_inbound_at = (SELECT MAX(sent_at) FROM messages WHERE ticket_id = ?1 AND direction = 'in'),
         unread = MAX(unread, ?2), status = CASE WHEN status IN ('closed','archived') THEN 'open' ELSE status END
       WHERE id = ?1`,
    ).bind(into.id, 0),
    env.DB.prepare("UPDATE tickets SET status = 'deleted', merged_into = ?, message_count = 0 WHERE id = ?").bind(into.id, from.id),
    env.DB.prepare("INSERT INTO events (ticket_id, agent_id, kind, detail) VALUES (?, ?, 'merged', ?)").bind(into.id, agentId, `#${from.id} merged in`),
  ]);
  await setTags(env, into, [...parseTags(into.tags), ...parseTags(from.tags)], agentId);
}

// ---------------------------------------------------------------- Rules engine

export type Trigger = "ticket_created" | "customer_message" | "agent_reply" | "status_changed";
export interface RuleCondition {
  field: "subject" | "body" | "from" | "has_tag" | "status" | "message_count" | "priority" | "assigned";
  op: "contains" | "not_contains" | "is" | "is_not" | "gt" | "lt" | "eq";
  value: string;
}
export interface RuleAction {
  type: "set_status" | "set_priority" | "add_tag" | "remove_tag" | "assign" | "auto_reply";
  value: string;
}
export interface SupportRule {
  id: number;
  name: string;
  trigger: Trigger;
  enabled: boolean;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export const RULE_FIELDS: Record<RuleCondition["field"], { label: string; ops: RuleCondition["op"][] }> = {
  subject: { label: "Subject", ops: ["contains", "not_contains", "is"] },
  body: { label: "Message body", ops: ["contains", "not_contains"] },
  from: { label: "Sent from (email or @domain)", ops: ["is", "is_not", "contains"] },
  has_tag: { label: "Has tag", ops: ["is", "is_not"] },
  status: { label: "Ticket status", ops: ["is", "is_not"] },
  priority: { label: "Priority", ops: ["is", "is_not"] },
  assigned: { label: "Assigned", ops: ["is"] },
  message_count: { label: "Message count", ops: ["gt", "lt", "eq"] },
};
export const RULE_ACTIONS: RuleAction["type"][] = ["set_status", "set_priority", "add_tag", "remove_tag", "assign", "auto_reply"];
export const TRIGGERS: Record<Trigger, string> = {
  ticket_created: "When a ticket is created",
  customer_message: "When a customer message arrives",
  agent_reply: "When a teammate replies",
  status_changed: "When a ticket's status changes",
};

const list = (v: string) => v.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

export function conditionMatches(c: RuleCondition, ctx: { ticket: TicketRow; message: { from: string; subject: string; body: string } | null }) {
  const t = ctx.ticket;
  const text = (s: string) => s.toLowerCase();
  switch (c.field) {
    case "subject":
    case "body": {
      const hay = text(c.field === "subject" ? ctx.message?.subject ?? t.subject : ctx.message?.body ?? "");
      const words = list(c.value);
      if (c.op === "is") return hay.trim() === c.value.trim().toLowerCase();
      const hit = words.some((w) => hay.includes(w));
      return c.op === "contains" ? hit : !hit;
    }
    case "from": {
      const from = text(ctx.message?.from ?? t.customer_email);
      const vals = list(c.value);
      const hit = vals.some((v) => (v.startsWith("@") ? from.endsWith(v) : c.op === "contains" ? from.includes(v) : from === v));
      return c.op === "is_not" ? !hit : hit;
    }
    case "has_tag": {
      const tags = parseTags(t.tags).map(text);
      const hit = list(c.value).some((v) => tags.includes(v));
      return c.op === "is" ? hit : !hit;
    }
    case "status":
    case "priority": {
      const cur = text((c.field === "status" ? t.status : t.priority) ?? "");
      const hit = list(c.value).includes(cur);
      return c.op === "is" ? hit : !hit;
    }
    case "assigned":
      return (c.value === "yes") === (t.assignee_id !== null);
    case "message_count": {
      const n = Number(c.value);
      return c.op === "gt" ? t.message_count > n : c.op === "lt" ? t.message_count < n : t.message_count === n;
    }
  }
}

export async function loadSupportRules(env: Env, trigger?: Trigger): Promise<SupportRule[]> {
  const stmt = trigger
    ? env.DB.prepare("SELECT * FROM support_rules WHERE trigger = ? ORDER BY position, id").bind(trigger)
    : env.DB.prepare("SELECT * FROM support_rules ORDER BY trigger, position, id");
  const { results } = await stmt.all<any>();
  return results.map((r) => ({ ...r, enabled: !!r.enabled, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) }));
}

/**
 * Runs the enabled rules for a trigger against a ticket. `sendAutoReply` is injected by the caller
 * (Gmail sending lives elsewhere). Logs "evaluated N rules" like Redo's activity feed.
 */
export async function runRules(
  env: Env,
  trigger: Trigger,
  ticketId: number,
  message: { from: string; subject: string; body: string } | null,
  sendAutoReply?: (t: TicketRow, macroId: number) => Promise<void>,
) {
  const rules = (await loadSupportRules(env, trigger)).filter((r) => r.enabled);
  if (!rules.length) return [];
  const t = await getTicket(env, ticketId);
  if (!t) return [];
  const fired: string[] = [];
  for (const r of rules) {
    const ctx = { ticket: t, message };
    const ok = r.conditions.length > 0 && (r.match === "any" ? r.conditions.some((c) => conditionMatches(c, ctx)) : r.conditions.every((c) => conditionMatches(c, ctx)));
    if (!ok) continue;
    fired.push(r.name);
    for (const a of r.actions) {
      try {
        if (a.type === "set_status" && (STATUSES as readonly string[]).includes(a.value)) await setStatus(env, t, a.value as Status, null, { source: `rule: ${r.name}` });
        else if (a.type === "set_priority") {
          await env.DB.prepare("UPDATE tickets SET priority = ? WHERE id = ?").bind(a.value || null, t.id).run();
          t.priority = a.value || null;
        } else if (a.type === "add_tag") await setTags(env, t, [...parseTags(t.tags), ...a.value.split(/[,\n]/).map((x) => x.trim())], null);
        else if (a.type === "remove_tag") await setTags(env, t, parseTags(t.tags).filter((x) => !list(a.value).includes(x.toLowerCase())), null);
        else if (a.type === "assign") {
          const id = a.value === "round_robin" || a.value === "balanced" ? await pickAssignee(env, a.value) : a.value === "nobody" ? null : Number(a.value);
          if (id === null || Number.isInteger(id)) await assign(env, t, id, null);
        } else if (a.type === "auto_reply" && sendAutoReply && Number(a.value) > 0) {
          // Smart sending: at most one automatic reply per ticket per 6 hours
          const recent = await env.DB.prepare(
            "SELECT 1 FROM events WHERE ticket_id = ? AND kind = 'auto_reply' AND created_at > ?",
          ).bind(t.id, new Date(Date.now() - 6 * 3600_000).toISOString()).first();
          if (!recent) {
            await sendAutoReply(t, Number(a.value));
            await logEvent(env, t.id, "auto_reply", r.name);
          }
        }
      } catch (e) {
        await logEvent(env, t.id, "rule_error", `${r.name}: ${(e as Error).message}`);
      }
    }
  }
  await logEvent(env, ticketId, "rules", `${TRIGGERS[trigger]}: evaluated ${rules.length} rule${rules.length === 1 ? "" : "s"}${fired.length ? ` · applied ${fired.join(", ")}` : ""}`);
  return fired;
}

/** Reopens snoozed tickets whose time has come (run from the minute cron). */
export async function wakeSnoozed(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM tickets WHERE status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= ?")
    .bind(nowIso())
    .all<TicketRow>();
  for (const t of results) {
    await setStatus(env, t, "open", null, { source: "snooze ended" });
    await env.DB.prepare("UPDATE tickets SET unread = 1 WHERE id = ?").bind(t.id).run();
  }
  return results.length;
}
