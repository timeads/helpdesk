import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { DEFAULT_RULES, getAttachment, getMailbox, importMessage, modifyThread, sendMacroAutoReply, sendRaw, syncMailbox, type MailRules } from "../lib/gmail";
import { buildMime, encodeRaw, escapeHtml, htmlToText, replySubject, textToHtml, type OutgoingAttachment } from "../lib/mime";
import { createDiscountCode, customerProfile, shopifyConfigured, type ShopifyOrder } from "../lib/shopify";
import { aiConfigured, draftReply, ticketInsights } from "../lib/ai";
import { demoProfile } from "../lib/demo";
import { chatForTicket, moveChatToEmail } from "../lib/chat";
import { renderMacro, type MacroContext } from "../lib/macros";
import {
  PRIORITIES,
  STATUSES,
  assign,
  getTicket,
  logEvent,
  mergeTickets,
  parseTags,
  runRules,
  setStatus,
  setTags,
  type Status,
  type TicketRow,
} from "../lib/support";
import { HttpError, base64UrlDecodeBytes, getSetting, nowIso, splitAddressList } from "../lib/util";

const tickets = new Hono<AppEnv>();

// ---------------------------------------------------------------- Views & filters

interface ViewFilters {
  status?: string; // "active" | "any" | a status
  tags_any?: string[];
  assignee?: string; // "me" | "none" | agent id
  priority?: string;
  unread?: boolean;
  q?: string;
  channel?: string; // "chat" for website chats
}

const BUILT_IN: Record<string, ViewFilters> = {
  mine: { status: "active", assignee: "me" },
  unassigned: { status: "open", assignee: "none" },
  open: { status: "open" },
  in_progress: { status: "in_progress" },
  pending: { status: "in_progress" }, // old name
  snoozed: { status: "snoozed" },
  closed: { status: "closed" },
  archived: { status: "archived" },
  spam: { status: "spam" },
  deleted: { status: "deleted" },
  all: { status: "any" },
  mentions: { status: "any" },
  chats: { status: "active", channel: "chat" },
};

async function viewFilters(env: Env, view: string): Promise<ViewFilters> {
  if (view.startsWith("v:")) {
    const row = await env.DB.prepare("SELECT filters FROM views WHERE id = ?").bind(Number(view.slice(2))).first<{ filters: string }>();
    if (!row) throw new HttpError(404, "That view no longer exists");
    return JSON.parse(row.filters || "{}");
  }
  return BUILT_IN[view] ?? BUILT_IN.open;
}

function whereFor(f: ViewFilters, agentId: number, view = ""): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  const st = f.status ?? "active";
  if (st === "active") clauses.push("t.status IN ('open','in_progress')");
  else if (st === "any") clauses.push("t.status NOT IN ('spam','deleted')");
  else if ((STATUSES as readonly string[]).includes(st)) {
    clauses.push("t.status = ?");
    args.push(st);
  }
  if (view === "mentions") {
    clauses.push("t.id IN (SELECT ticket_id FROM mentions WHERE agent_id = ?)");
    args.push(agentId);
  }
  if (f.assignee === "me") {
    clauses.push("t.assignee_id = ?");
    args.push(agentId);
  } else if (f.assignee === "none") clauses.push("t.assignee_id IS NULL");
  else if (f.assignee && /^\d+$/.test(f.assignee)) {
    clauses.push("t.assignee_id = ?");
    args.push(Number(f.assignee));
  }
  if (f.priority) {
    if (f.priority === "none") clauses.push("t.priority IS NULL");
    else {
      clauses.push("t.priority = ?");
      args.push(f.priority);
    }
  }
  if (f.unread) clauses.push("t.unread = 1");
  if (f.channel === "chat" || f.channel === "email") {
    clauses.push("t.channel = ?");
    args.push(f.channel);
  }
  if (f.tags_any?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value COLLATE NOCASE IN (${f.tags_any.map(() => "?").join(",")}))`);
    args.push(...f.tags_any);
  }
  const q = (f.q ?? "").trim();
  if (q) {
    const like = `%${q}%`;
    clauses.push(
      `(t.subject LIKE ? OR t.customer_email LIKE ? OR t.customer_name LIKE ? OR t.snippet LIKE ? OR CAST(t.id AS TEXT) = ?
        OR t.id IN (SELECT ticket_id FROM messages WHERE body_text LIKE ? LIMIT 200))`,
    );
    args.push(like, like, like, like, q.replace(/^#/, ""), like);
  }
  return { sql: clauses.join(" AND ") || "1 = 1", args };
}

/** View + the ad-hoc filters from the query string (tag, assignee, priority, unread, q). */
async function listWhere(env: Env, query: Record<string, string>, agentId: number) {
  const view = query.view || "open";
  const f = { ...(await viewFilters(env, view)) };
  if (query.tag) f.tags_any = [...(f.tags_any ?? []), ...query.tag.split(",")];
  if (query.assignee) f.assignee = query.assignee;
  if (query.priority) f.priority = query.priority;
  if (query.unread === "1") f.unread = true;
  if (query.q) f.q = query.q;
  if (query.status) f.status = query.status;
  return whereFor(f, agentId, view);
}

const ORDER: Record<string, string> = {
  recent: "t.last_message_at DESC",
  oldest: "t.last_message_at ASC",
  waiting: "COALESCE(t.last_inbound_at, t.created_at) ASC",
  created: "t.created_at DESC",
  priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END, t.last_message_at DESC",
};

const LIST_COLUMNS = `t.id, t.subject, t.customer_email, t.customer_name, t.status, t.priority, t.tags, t.assignee_id, a.name AS assignee_name,
  t.unread, t.snippet, t.message_count, t.last_message_at, t.last_inbound_at, t.created_at, t.snoozed_until, t.ai_sentiment, t.channel`;

const withTags = <T extends { tags?: string }>(r: T) => ({ ...r, tags: parseTags(r.tags) });

tickets.get("/counts", async (c) => {
  const me = c.get("agent").id;
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(status = 'open') AS open,
       SUM(status IN ('open','in_progress') AND assignee_id = ?1) AS mine,
       SUM(status = 'open' AND assignee_id IS NULL) AS unassigned,
       SUM(status = 'in_progress') AS in_progress,
       SUM(status = 'snoozed') AS snoozed,
       SUM(status = 'spam') AS spam,
       (SELECT COUNT(DISTINCT ticket_id) FROM mentions WHERE agent_id = ?1 AND seen = 0) AS mentions,
       (SELECT COUNT(*) FROM chats WHERE state = 'waiting') AS chats_waiting,
       SUM(status IN ('open','in_progress') AND channel = 'chat') AS chats
     FROM tickets`,
  )
    .bind(me)
    .first<Record<string, number>>();
  const { results: views } = await c.env.DB.prepare("SELECT id, filters FROM views").all<{ id: number; filters: string }>();
  const custom: Record<string, number> = {};
  for (const v of views) {
    const w = whereFor(JSON.parse(v.filters || "{}"), me);
    const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM tickets t WHERE ${w.sql}`).bind(...w.args).first<{ n: number }>();
    custom[`v:${v.id}`] = r?.n ?? 0;
  }
  return c.json({ ...row, pending: row?.in_progress ?? 0, ...custom });
});

tickets.get("/", async (c) => {
  const query = c.req.query();
  const where = await listWhere(c.env, query, c.get("agent").id);
  const offset = Math.max(0, Number(query.offset) || 0);
  const order = ORDER[query.sort ?? "recent"] ?? ORDER.recent;
  const { results } = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id
     WHERE ${where.sql} ORDER BY ${order} LIMIT 51 OFFSET ?`,
  )
    .bind(...where.args, offset)
    .all<any>();
  return c.json({ tickets: results.slice(0, 50).map(withTags), more: results.length > 50 });
});

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the current view (or of selected ids). */
tickets.get("/export.csv", async (c) => {
  const query = c.req.query();
  let where: { sql: string; args: unknown[] };
  const ids = (query.ids ?? "").split(",").map(Number).filter((n) => n > 0).slice(0, 2000);
  if (ids.length) where = { sql: `t.id IN (${ids.map(() => "?").join(",")})`, args: ids };
  else where = await listWhere(c.env, query, c.get("agent").id);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.subject, t.customer_name, t.customer_email, t.status, t.priority, a.name AS assignee, t.tags, t.message_count,
            t.created_at, t.last_message_at, t.first_response_at, t.resolved_at, t.ai_type, t.ai_sentiment
     FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id WHERE ${where.sql} ORDER BY t.created_at DESC LIMIT 5000`,
  )
    .bind(...where.args)
    .all<any>();
  const cols = ["id", "subject", "customer_name", "customer_email", "status", "priority", "assignee", "tags", "message_count", "created_at", "last_message_at", "first_response_at", "resolved_at", "ai_type", "ai_sentiment"];
  const lines = [cols.join(",")];
  for (const r of results) lines.push(cols.map((k) => csvCell(k === "tags" ? parseTags(r.tags).join("; ") : r[k])).join(","));
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="tickets-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

// ---------------------------------------------------------------- One ticket

async function loadTicket(env: Env, id: number) {
  const t = await env.DB.prepare(`SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id WHERE t.id = ?`)
    .bind(id)
    .first<any>();
  if (!t) throw new HttpError(404, "Ticket not found");
  return t as TicketRow & Record<string, any>;
}

const publicTicket = (t: any) => withTags(t);

tickets.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent").id;
  const ticket = await loadTicket(c.env, id);
  const [messages, notes, events, threads] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT m.id, m.direction, m.from_email, m.from_name, m.to_emails, m.cc_emails, m.bcc_emails, m.subject, m.sent_at,
              m.body_text, m.body_html, m.attachments, m.gmail_message_id, m.thread_id, m.kind, m.extra, a.name AS agent_name
       FROM messages m LEFT JOIN agents a ON a.id = m.agent_id WHERE m.ticket_id = ? ORDER BY m.sent_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT n.id, n.body, n.created_at, n.agent_id, a.name AS agent_name FROM notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.ticket_id = ? ORDER BY n.created_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT e.kind, e.detail, e.created_at, a.name AS agent_name FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.ticket_id = ? ORDER BY e.created_at, e.id`,
    ).bind(id),
    c.env.DB.prepare("SELECT thread_id, subject, created_at FROM ticket_threads WHERE ticket_id = ? ORDER BY created_at").bind(id),
  ]);
  const writes: D1PreparedStatement[] = [c.env.DB.prepare("UPDATE mentions SET seen = 1 WHERE ticket_id = ? AND agent_id = ? AND seen = 0").bind(id, me)];
  if (ticket.unread) writes.push(c.env.DB.prepare("UPDATE tickets SET unread = 0 WHERE id = ?").bind(id));
  await c.env.DB.batch(writes);
  return c.json({
    ticket: publicTicket({ ...ticket, unread: 0 }),
    messages: messages.results.map((m: any) => ({ ...m, attachments: JSON.parse(m.attachments || "[]") })),
    notes: notes.results,
    events: events.results,
    threads: threads.results,
    chat: ticket.channel === "chat" ? await chatForTicket(c.env, id).then((ch) => (ch ? { state: ch.state, email: ch.email } : null)) : null,
  });
});

/** Gmail follows the ticket: closed/archived/deleted leave the inbox, spam goes to Gmail spam. */
async function mirrorToGmail(env: Env, ticketId: number, status: string, previous?: string) {
  const { results } = await env.DB.prepare("SELECT thread_id FROM ticket_threads WHERE ticket_id = ?").bind(ticketId).all<{ thread_id: string }>();
  if (!results.length) return;
  const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };
  let add: string[] = [];
  let remove: string[] = [];
  if (status === "spam") [add, remove] = [["SPAM"], ["INBOX"]];
  else if (previous === "spam") [add, remove] = [["INBOX"], ["SPAM"]];
  else if (["closed", "archived", "deleted"].includes(status) && rules.archiveOnClose) remove = ["INBOX", "UNREAD"];
  else return;
  for (const r of results) {
    try {
      await modifyThread(env, r.thread_id, add, remove);
    } catch {
      /* Gmail mirroring is a convenience; never fail the request over it */
    }
  }
}

function parseStatus(s: unknown): Status {
  if (!(STATUSES as readonly string[]).includes(String(s))) throw new HttpError(400, "Unknown status");
  return s as Status;
}

/** Status change by a teammate: logs, mirrors to Gmail, runs "status changed" rules. */
async function changeStatus(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, t: TicketRow, status: Status, agentId: number, snoozeUntil?: string | null) {
  if (status === "snoozed" && !snoozeUntil) throw new HttpError(400, "Pick when the ticket should come back");
  const previous = t.status;
  const changed = await setStatus(env, t, status, agentId, { snoozeUntil });
  if (!changed) return;
  ctx.waitUntil(
    (async () => {
      await mirrorToGmail(env, t.id, status, previous);
      await runRules(env, "status_changed", t.id, null, (tk, m) => sendMacroAutoReply(env, tk, m));
    })().catch((e) => console.error("after status change", e)),
  );
}

tickets.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent");
  const body = await c.req.json<{
    status?: string;
    snooze_until?: string | null;
    assignee_id?: number | null;
    unread?: boolean;
    priority?: string | null;
    tags?: string[];
    subject?: string;
  }>();
  const t = await loadTicket(c.env, id);
  if (body.status) await changeStatus(c.env, c.executionCtx, t, parseStatus(body.status), me.id, body.snooze_until);
  if (body.assignee_id !== undefined) {
    try {
      await assign(c.env, t, body.assignee_id, me.id);
    } catch {
      throw new HttpError(400, "Unknown teammate");
    }
  }
  if (body.unread !== undefined) await c.env.DB.prepare("UPDATE tickets SET unread = ? WHERE id = ?").bind(body.unread ? 1 : 0, id).run();
  if (body.priority !== undefined && body.priority !== t.priority) {
    if (body.priority !== null && !(PRIORITIES as readonly string[]).includes(body.priority)) throw new HttpError(400, "Unknown priority");
    await c.env.DB.prepare("UPDATE tickets SET priority = ? WHERE id = ?").bind(body.priority, id).run();
    await logEvent(c.env, id, "priority", body.priority ?? "none", me.id);
  }
  if (body.tags) await setTags(c.env, t, body.tags, me.id);
  if (body.subject !== undefined && body.subject.trim() && body.subject.trim() !== t.subject) {
    await c.env.DB.prepare("UPDATE tickets SET subject = ? WHERE id = ?").bind(body.subject.trim().slice(0, 300), id).run();
    await logEvent(c.env, id, "subject", body.subject.trim().slice(0, 300), me.id);
  }
  return c.json({ ticket: publicTicket(await loadTicket(c.env, id)) });
});

/** Bulk changes from the list: status, snooze, assignee, priority, tags, read state. */
tickets.post("/bulk", async (c) => {
  const me = c.get("agent");
  const body = await c.req.json<{
    ids: number[];
    status?: string;
    snooze_until?: string;
    assignee_id?: number | null;
    priority?: string | null;
    add_tags?: string[];
    remove_tags?: string[];
    unread?: boolean;
  }>();
  const ids = [...new Set((body.ids ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  if (!ids.length) throw new HttpError(400, "Select at least one ticket");
  const status = body.status ? parseStatus(body.status) : null;
  if (status === "snoozed" && !body.snooze_until) throw new HttpError(400, "Pick when the tickets should come back");
  if (body.priority && !(PRIORITIES as readonly string[]).includes(body.priority)) throw new HttpError(400, "Unknown priority");
  let changed = 0;
  for (const id of ids) {
    const t = await getTicket(c.env, id);
    if (!t) continue;
    let did = false;
    if (status && t.status !== status) {
      const prev = t.status;
      await setStatus(c.env, t, status, me.id, { snoozeUntil: body.snooze_until });
      c.executionCtx.waitUntil(mirrorToGmail(c.env, t.id, status, prev));
      did = true;
    }
    if (body.assignee_id !== undefined && body.assignee_id !== t.assignee_id) {
      try {
        await assign(c.env, t, body.assignee_id, me.id);
      } catch {
        throw new HttpError(400, "Unknown teammate");
      }
      did = true;
    }
    if (body.priority !== undefined && body.priority !== t.priority) {
      await c.env.DB.prepare("UPDATE tickets SET priority = ? WHERE id = ?").bind(body.priority, id).run();
      await logEvent(c.env, id, "priority", body.priority ?? "none", me.id);
      did = true;
    }
    if (body.add_tags?.length || body.remove_tags?.length) {
      const drop = new Set((body.remove_tags ?? []).map((x) => x.toLowerCase()));
      await setTags(c.env, t, [...parseTags(t.tags).filter((x) => !drop.has(x.toLowerCase())), ...(body.add_tags ?? [])], me.id);
      did = true;
    }
    if (body.unread !== undefined) {
      await c.env.DB.prepare("UPDATE tickets SET unread = ? WHERE id = ?").bind(body.unread ? 1 : 0, id).run();
      did = true;
    }
    if (did) changed++;
  }
  return c.json({ ok: true, updated: ids.length, changed });
});

// ---------------------------------------------------------------- Merge

tickets.get("/:id{[0-9]+}/merge-suggestions", async (c) => {
  const t = await loadTicket(c.env, Number(c.req.param("id")));
  const { results } = await c.env.DB.prepare(
    `SELECT id, subject, status, last_message_at, message_count FROM tickets
     WHERE customer_email = ? AND id != ? AND status NOT IN ('deleted','spam') ORDER BY last_message_at DESC LIMIT 10`,
  )
    .bind(t.customer_email, t.id)
    .all();
  return c.json({ tickets: results });
});

/** Merge other tickets into this one (`ids`), or this ticket into `into`. */
tickets.post("/:id{[0-9]+}/merge", async (c) => {
  const me = c.get("agent");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ ids?: number[]; into?: number }>();
  const pairs: [number, number][] = body.into ? [[id, Number(body.into)]] : (body.ids ?? []).map((x) => [Number(x), id]);
  if (!pairs.length) throw new HttpError(400, "Choose tickets to merge");
  let target = id;
  for (const [fromId, intoId] of pairs) {
    if (fromId === intoId) continue;
    const from = await getTicket(c.env, fromId);
    const into = await getTicket(c.env, intoId);
    if (!from || !into) throw new HttpError(404, "Ticket not found");
    if (into.status === "deleted") throw new HttpError(400, "Can't merge into a deleted ticket");
    await mergeTickets(c.env, from, into, me.id);
    target = intoId;
  }
  return c.json({ ok: true, ticketId: target });
});

// ---------------------------------------------------------------- Notes & mentions

tickets.post("/:id{[0-9]+}/notes", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent");
  const { body, mentions } = await c.req.json<{ body: string; mentions?: number[] }>();
  if (!body?.trim()) throw new HttpError(400, "Note is empty");
  await loadTicket(c.env, id);
  const note = await c.env.DB.prepare("INSERT INTO notes (ticket_id, agent_id, body) VALUES (?, ?, ?) RETURNING id")
    .bind(id, me.id, body.trim())
    .first<{ id: number }>();
  const ids = [...new Set((mentions ?? []).map(Number).filter((n) => n > 0 && n !== me.id))];
  if (ids.length) {
    const { results } = await c.env.DB.prepare(`SELECT id, name FROM agents WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: number; name: string }>();
    if (results.length) {
      await c.env.DB.batch(results.map((a) => c.env.DB.prepare("INSERT INTO mentions (ticket_id, note_id, agent_id) VALUES (?, ?, ?)").bind(id, note!.id, a.id)));
      await logEvent(c.env, id, "mention", results.map((a) => a.name).join(", "), me.id);
    }
  }
  return c.json({ ok: true });
});

tickets.delete("/:id{[0-9]+}/notes/:nid{[0-9]+}", async (c) => {
  const me = c.get("agent");
  const r = await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND ticket_id = ? AND (agent_id = ? OR ? = 'admin')")
    .bind(Number(c.req.param("nid")), Number(c.req.param("id")), me.id, me.role)
    .run();
  if (!r.meta.changes) throw new HttpError(404, "Note not found");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Sending

interface MacroAction {
  type: "add_tags" | "set_status" | "set_subject" | "add_note" | "set_priority";
  value: string;
}

interface SendBody {
  html?: string;
  text?: string;
  mode?: "reply" | "reply_all" | "forward";
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  status?: string;
  snooze_until?: string;
  attachments?: OutgoingAttachment[];
  forward_message_id?: number;
  include_attachments?: boolean;
  macro_ids?: number[];
  macro_actions?: MacroAction[];
  tags?: string[]; // new emails: tags for the ticket (e.g. "Shipping" from the order page)
  order_name?: string; // new emails sent from an order: noted on the ticket
}

const validEmails = (list: string[] | undefined) =>
  (list ?? []).flatMap((x) => splitAddressList(x)).map((x) => x.trim()).filter((x) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(x));

/** Turns the composer's content (+ signature) into text and HTML bodies. */
function bodies(body: SendBody, signature: string) {
  const rawHtml = (body.html ?? "").trim();
  const text = (body.text?.trim() || (rawHtml ? htmlToText(rawHtml) : "")).trim();
  if (!text && !rawHtml) throw new HttpError(400, "Message is empty");
  const sigText = signature ? `\n\n${signature}` : "";
  const html = rawHtml ? `<div>${rawHtml}</div>${signature ? `<br><div>${textToHtml(signature)}</div>` : ""}` : textToHtml(text + sigText);
  return { text: text + sigText, html };
}

function checkAttachments(a: OutgoingAttachment[] | undefined) {
  const total = (a ?? []).reduce((n, x) => n + x.base64.length * 0.75, 0);
  if (total > 20 * 1024 * 1024) throw new HttpError(413, "Attachments are over Gmail's 25 MB limit");
}

async function signatureFor(env: Env, agent: { signature?: string }) {
  return agent.signature?.trim() || (await getSetting<string>(env, "signature", "")).trim();
}

async function applyMacroActions(env: Env, t: TicketRow, actions: MacroAction[], agentId: number) {
  for (const a of actions) {
    if (a.type === "add_tags") await setTags(env, t, [...parseTags(t.tags), ...a.value.split(",").map((x) => x.trim())], agentId);
    else if (a.type === "set_subject" && a.value.trim()) {
      await env.DB.prepare("UPDATE tickets SET subject = ? WHERE id = ?").bind(a.value.trim().slice(0, 300), t.id).run();
      await logEvent(env, t.id, "subject", a.value.trim(), agentId);
    } else if (a.type === "add_note" && a.value.trim()) {
      await env.DB.prepare("INSERT INTO notes (ticket_id, agent_id, body) VALUES (?, ?, ?)").bind(t.id, agentId, a.value.trim()).run();
    } else if (a.type === "set_priority" && (PRIORITIES as readonly string[]).includes(a.value)) {
      await env.DB.prepare("UPDATE tickets SET priority = ? WHERE id = ?").bind(a.value, t.id).run();
      t.priority = a.value;
    }
  }
}

tickets.post("/:id{[0-9]+}/reply", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent");
  const body = await c.req.json<SendBody>();
  checkAttachments(body.attachments);
  const ticket = await loadTicket(c.env, id);
  const box = await getMailbox(c.env);
  if (!box) throw new HttpError(409, "Connect the support mailbox in Settings first");
  const mode = body.mode ?? "reply";
  if (ticket.channel === "chat" && mode === "reply") {
    const chat = await chatForTicket(c.env, id);
    if (chat && chat.state !== "email") {
      const { text } = bodies(body, await signatureFor(c.env, me));
      await moveChatToEmail(c.env, chat, { reason: `${me.name} replied by email`, lead: text, agentId: me.id });
      return c.json({ ok: true, ticket: publicTicket(await loadTicket(c.env, id)) });
    }
  }

  const { results: msgs } = await c.env.DB.prepare(
    `SELECT id, rfc_message_id, thread_id, direction, from_email, from_name, to_emails, cc_emails, subject, sent_at,
            body_text, body_html, attachments, gmail_message_id FROM messages WHERE ticket_id = ? ORDER BY sent_at`,
  )
    .bind(id)
    .all<any>();
  const last = msgs.at(-1);
  const support = box.email.toLowerCase();

  let to = validEmails(body.to);
  let cc = validEmails(body.cc);
  const bcc = validEmails(body.bcc);
  if (mode !== "forward" && !to.length) to = [ticket.customer_email];
  if (mode === "reply_all" && !body.cc && last) {
    const others = [last.from_email, ...splitAddressList(last.to_emails), ...splitAddressList(last.cc_emails)];
    const toLower = to.map((y) => y.toLowerCase());
    cc = [...new Set(others.map((x: string) => x.toLowerCase()))].filter((x) => x !== support && !toLower.includes(x));
  }
  if (!to.length) throw new HttpError(400, "Add at least one recipient");

  const signature = await signatureFor(c.env, me);
  let { text, html } = bodies(body, signature);
  let attachments = body.attachments ?? [];
  let subject = body.subject?.trim() || replySubject(ticket.subject);
  let threadId: string | null = last?.thread_id ?? ticket.gmail_thread_id;
  let inReplyTo: string | null = null;
  let references: string | null = null;

  if (mode === "forward") {
    const src = (body.forward_message_id ? msgs.find((m) => m.id === body.forward_message_id) : last) ?? last;
    if (src) {
      const head = [
        "---------- Forwarded message ---------",
        `From: ${src.from_name ? `${src.from_name} <${src.from_email}>` : src.from_email}`,
        `Date: ${new Date(src.sent_at).toUTCString()}`,
        `Subject: ${src.subject ?? ticket.subject}`,
        `To: ${src.to_emails}`,
      ];
      text += `\n\n${head.join("\n")}\n\n${src.body_text}`;
      html += `<br><br><div>${head.map(escapeHtml).join("<br>")}</div><br>${src.body_html || textToHtml(src.body_text)}`;
      if (body.include_attachments !== false) {
        const metas = JSON.parse(src.attachments || "[]") as { id: string; filename: string; mimeType: string; size?: number }[];
        if (metas.reduce((n, a) => n + (a.size ?? 0), 0) < 18 * 1024 * 1024) {
          for (const a of metas) {
            const data = await getAttachment(c.env, src.gmail_message_id, a.id);
            attachments = [...attachments, { filename: a.filename, mimeType: a.mimeType, base64: data.replace(/-/g, "+").replace(/_/g, "/") }];
          }
        }
      }
      checkAttachments(attachments);
    }
    subject = body.subject?.trim() || `Fwd: ${(src?.subject ?? ticket.subject).replace(/^(fwd?|fw):\s*/i, "")}`;
    threadId = null; // a forward starts its own Gmail thread, kept on this ticket
  } else {
    const refs = msgs.filter((m) => m.rfc_message_id && (!m.thread_id || m.thread_id === threadId)).map((m) => m.rfc_message_id as string);
    inReplyTo = refs.at(-1) ?? null;
    references = refs.slice(-20).join(" ") || null;
  }

  const mime = buildMime({ fromEmail: box.email, fromName: c.env.APP_NAME, to, cc, bcc, subject, inReplyTo, references, text, html, attachments });
  const sent = await sendRaw(c.env, encodeRaw(mime), threadId);
  await c.env.DB.prepare("INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) VALUES (?, ?, ?)").bind(sent.threadId, id, subject).run();
  await importMessage(c.env, sent.id, { agentId: me.id, force: true, skipRules: true });
  if (mode === "forward") await logEvent(c.env, id, "forwarded", to.join(", "), me.id);

  // After sending: macro automations, status, assignment, rules
  const t = (await getTicket(c.env, id))!;
  if (body.macro_actions?.length) await applyMacroActions(c.env, t, body.macro_actions, me.id);
  for (const mid of body.macro_ids ?? []) await c.env.DB.prepare("UPDATE macros SET uses = uses + 1 WHERE id = ?").bind(mid).run();
  await c.env.DB.prepare("UPDATE tickets SET unread = 0 WHERE id = ?").bind(id).run();
  if (t.assignee_id === null) await assign(c.env, t, me.id, me.id);
  const status = parseStatus(body.status ?? (mode === "forward" ? t.status : "in_progress"));
  await changeStatus(c.env, c.executionCtx, t, status, me.id, body.snooze_until);
  c.executionCtx.waitUntil(
    runRules(c.env, "agent_reply", id, { from: box.email, subject, body: text.slice(0, 20000) }, (tk, m) => sendMacroAutoReply(c.env, tk, m)).catch(() => {}),
  );
  return c.json({ ok: true, ticket: publicTicket(await loadTicket(c.env, id)) });
});

/** Compose a brand-new email; it becomes a ticket straight away. */
tickets.post("/new", async (c) => {
  const me = c.get("agent");
  const body = await c.req.json<SendBody>();
  checkAttachments(body.attachments);
  const box = await getMailbox(c.env);
  if (!box) throw new HttpError(409, "Connect the support mailbox in Settings first");
  const to = validEmails(body.to);
  if (!to.length) throw new HttpError(400, "Add at least one recipient");
  const subject = body.subject?.trim();
  if (!subject) throw new HttpError(400, "Add a subject");
  const { text, html } = bodies(body, await signatureFor(c.env, me));
  const mime = buildMime({
    fromEmail: box.email,
    fromName: c.env.APP_NAME,
    to,
    cc: validEmails(body.cc),
    bcc: validEmails(body.bcc),
    subject,
    text,
    html,
    attachments: body.attachments,
  });
  const sent = await sendRaw(c.env, encodeRaw(mime), null);
  const now = nowIso();
  const status = body.status === "closed" ? "closed" : body.status === "open" ? "open" : "in_progress";
  const t = await c.env.DB.prepare(
    `INSERT INTO tickets (gmail_thread_id, subject, customer_email, customer_name, status, unread, snippet, created_at, last_message_at, assignee_id, first_response_at, closed_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(sent.threadId, subject, to[0].toLowerCase(), status, text.slice(0, 200), now, now, me.id, now, status === "closed" ? now : null)
    .first<{ id: number }>();
  await c.env.DB.prepare("INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) VALUES (?, ?, ?)").bind(sent.threadId, t!.id, subject).run();
  await logEvent(c.env, t!.id, "created", body.order_name ? `New email about order ${String(body.order_name).slice(0, 40)} (from Shipping)` : "New email", me.id);
  await importMessage(c.env, sent.id, { agentId: me.id, force: true, skipRules: true });
  const tags = (Array.isArray(body.tags) ? body.tags : []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 10);
  if (tags.length) {
    const row = await getTicket(c.env, t!.id);
    if (row) await setTags(c.env, row, tags, me.id);
  }
  return c.json({ ok: true, ticketId: t!.id });
});

// ---------------------------------------------------------------- Macros, AI, discounts

async function orderContext(env: Env, email: string): Promise<{ orders: ShopifyOrder[]; customerName: string | null }> {
  try {
    if (shopifyConfigured(env)) {
      const p = await customerProfile(env, email);
      return { orders: p.orders, customerName: p.customer?.displayName ?? null };
    }
    if (env.DEMO_DATA === "1") {
      const p = demoProfile(email) as any;
      return { orders: p?.orders ?? [], customerName: p?.customer?.displayName ?? null };
    }
  } catch {
    /* macros still render without order data */
  }
  return { orders: [], customerName: null };
}

function macroContextFor(t: TicketRow, agentName: string, orders: ShopifyOrder[], customerName: string | null): MacroContext {
  const o = orders[0];
  const track = o?.fulfillments.flatMap((f) => f.trackingInfo.map((ti) => ({ ...ti, at: f.createdAt, status: f.displayStatus })))[0];
  const a = o?.shippingAddress;
  return {
    agent: { name: agentName },
    customer: { email: t.customer_email, name: t.customer_name || customerName },
    order: o
      ? {
          name: o.name,
          createdAt: o.createdAt,
          total: `$${Number(o.totalPriceSet.shopMoney.amount).toFixed(2)}`,
          fulfillmentStatus: o.displayFulfillmentStatus,
          deliveryStatus: track?.status ?? null,
          shippedAt: track?.at ?? null,
          trackingNumber: track?.number ?? null,
          trackingUrl: track?.url ?? null,
          shippingAddress: a ? [a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") : null,
        }
      : null,
    storeName: "Tuft the World",
  };
}

/** Fills a macro's variables for this ticket ({{customer.first_name}}, {{order.tracking_url}} …). */
tickets.post("/:id{[0-9]+}/render-macro", async (c) => {
  const id = Number(c.req.param("id"));
  const { macro_id, text } = await c.req.json<{ macro_id?: number; text?: string }>();
  const t = await loadTicket(c.env, id);
  let source = text ?? "";
  let actions: MacroAction[] = [];
  if (macro_id) {
    const m = await c.env.DB.prepare("SELECT body, actions FROM macros WHERE id = ?").bind(macro_id).first<{ body: string; actions: string }>();
    if (!m) throw new HttpError(404, "Saved reply not found");
    source = m.body;
    actions = JSON.parse(m.actions || "[]");
  }
  const needsOrder = /\{\{\s*order\./.test(source + JSON.stringify(actions));
  const { orders, customerName } = needsOrder ? await orderContext(c.env, t.customer_email) : { orders: [], customerName: null };
  const ctx = macroContextFor(t, c.get("agent").name, orders, customerName);
  return c.json({
    text: renderMacro(source, ctx),
    actions: actions.map((a) => ({ ...a, value: renderMacro(a.value, ctx) })),
  });
});

tickets.post("/:id{[0-9]+}/ai-draft", async (c) => {
  const id = Number(c.req.param("id"));
  const { instruction } = await c.req.json<{ instruction?: string }>().catch(() => ({ instruction: undefined }));
  if (!aiConfigured(c.env)) throw new HttpError(409, "AI drafts are off — add an Anthropic API key in Settings → Connections.");
  const ticket = await loadTicket(c.env, id);
  const [{ results: messages }, { results: notes }] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT direction, from_email, sent_at, body_text FROM messages WHERE ticket_id = ? ORDER BY sent_at").bind(id),
    c.env.DB.prepare("SELECT body FROM notes WHERE ticket_id = ? ORDER BY created_at").bind(id),
  ]);
  const { orders: raw } = await orderContext(c.env, ticket.customer_email);
  const orders = raw.slice(0, 5).map((o) => ({
    name: o.name,
    placed: o.createdAt,
    financial: o.displayFinancialStatus,
    fulfillment: o.displayFulfillmentStatus,
    cancelled: !!o.cancelledAt,
    total: o.totalPriceSet.shopMoney,
    items: o.lineItems.nodes.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`),
    shipping: o.shippingLines.nodes[0]?.title,
    tracking: o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => ({ status: f.displayStatus, ...t }))),
  }));
  const draft = await draftReply(c.env, {
    storeName: c.env.APP_NAME,
    agentName: c.get("agent").name,
    customerName: ticket.customer_name,
    subject: ticket.subject,
    thread: (messages as any[]).map((m) => ({ direction: m.direction, from: m.from_email, sentAt: m.sent_at, text: m.body_text })),
    notes: (notes as any[]).map((n) => n.body),
    orders,
    instruction,
  });
  return c.json({ draft });
});

/** On-demand summary, sentiment and type (one small AI call; saved on the ticket). */
tickets.post("/:id{[0-9]+}/ai-insights", async (c) => {
  const id = Number(c.req.param("id"));
  const ticket = await loadTicket(c.env, id);
  const { results } = await c.env.DB.prepare("SELECT direction, from_email, sent_at, body_text FROM messages WHERE ticket_id = ? ORDER BY sent_at")
    .bind(id)
    .all<any>();
  const r = await ticketInsights(
    c.env,
    ticket.subject,
    results.map((m) => ({ direction: m.direction, from: m.from_email, sentAt: m.sent_at, text: m.body_text })),
  );
  await c.env.DB.prepare("UPDATE tickets SET ai_summary = ?, ai_sentiment = ?, ai_type = ?, ai_updated_at = ? WHERE id = ?")
    .bind(r.summary, r.sentiment, r.type, nowIso(), id)
    .run();
  return c.json({ ticket: publicTicket(await loadTicket(c.env, id)) });
});

/** Creates a single-use Shopify discount code to paste into a reply. */
tickets.post("/:id{[0-9]+}/discount", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ kind: "percentage" | "amount"; value: number; code?: string; days?: number }>();
  if (!shopifyConfigured(c.env)) throw new HttpError(409, "Connect Shopify in Settings → Connections first");
  const value = Number(body.value);
  if (!(value > 0) || (body.kind === "percentage" && value > 100)) throw new HttpError(400, "Enter a discount amount");
  const code = (body.code?.trim() || `TTW-${crypto.randomUUID().slice(0, 6).toUpperCase()}`).replace(/\s+/g, "").toUpperCase();
  const t = await loadTicket(c.env, id);
  const r = await createDiscountCode(c.env, {
    code,
    kind: body.kind === "amount" ? "amount" : "percentage",
    value,
    days: body.days ? Math.min(365, Math.max(1, Number(body.days))) : undefined,
    title: `Support #${id}: ${t.customer_email}`,
  });
  await logEvent(c.env, id, "discount", `${code} (${body.kind === "amount" ? `$${value}` : `${value}%`} off)`, c.get("agent").id);
  return c.json(r);
});

// ---------------------------------------------------------------- Attachments, sync, customer

tickets.get("/:id{[0-9]+}/messages/:mid{[0-9]+}/attachments/:aid", async (c) => {
  const m = await c.env.DB.prepare("SELECT gmail_message_id, attachments FROM messages WHERE id = ? AND ticket_id = ?")
    .bind(Number(c.req.param("mid")), Number(c.req.param("id")))
    .first<{ gmail_message_id: string; attachments: string }>();
  if (!m) throw new HttpError(404, "Not found");
  const meta = (JSON.parse(m.attachments) as { id: string; filename: string; mimeType: string }[]).find((a) => a.id === c.req.param("aid"));
  if (!meta) throw new HttpError(404, "Attachment not found");
  const data = !m.gmail_message_id && /^c\d+$/.test(meta.id)
    ? (await c.env.DB.prepare("SELECT data FROM chat_files WHERE id = ?").bind(Number(meta.id.slice(1))).first<{ data: string }>())?.data ?? ""
    : await getAttachment(c.env, m.gmail_message_id, meta.id);
  const inline = /^(image\/|video\/|application\/pdf)/.test(meta.mimeType) && c.req.query("download") === undefined;
  const bytes = base64UrlDecodeBytes(data);
  const headers: Record<string, string> = {
    "content-type": meta.mimeType,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "accept-ranges": "bytes",
  };
  // Videos play in the repair manual; Safari asks for byte ranges
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    const size = bytes.length;
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` } });
  }
  return new Response(bytes, { headers });
});

tickets.post("/sync", async (c) => c.json(await syncMailbox(c.env)));

tickets.get("/customer/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const { results: history } = await c.env.DB.prepare(
    "SELECT id, subject, status, last_message_at FROM tickets WHERE customer_email = ? AND status != 'deleted' ORDER BY last_message_at DESC LIMIT 20",
  )
    .bind(email)
    .all();
  let shopify: unknown = null;
  let shopifyError: string | null = null;
  if (shopifyConfigured(c.env)) {
    try {
      shopify = await customerProfile(c.env, email);
    } catch (e) {
      shopifyError = (e as Error).message;
    }
  } else if (c.env.DEMO_DATA === "1") shopify = demoProfile(email);
  else shopifyError = "not_configured";
  return c.json({ email, tickets: history, shopify, shopifyError });
});

export default tickets;
