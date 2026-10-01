import type { Env } from "../env";
import { refreshAccessToken } from "./google";
import { extractContent, headerMap, isAutomated, type GmailPart } from "./mime";
import { HttpError, cachedToken, decrypt, getSetting, nowIso, parseAddress, setSetting, splitAddressList } from "./util";
import { assign, logEvent, pickAssignee, runRules, setStatus, supportSettings, type TicketRow } from "./support";
import { renderMacro } from "./macros";
import { aiConfigured, ticketInsights } from "./ai";
import { buildMime, encodeRaw, replySubject } from "./mime";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MailboxState {
  email: string;
  refreshToken: string; // encrypted
  historyId?: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string | null;
  catchingUp?: boolean; // the last run hit its request budget; the next one continues
}

export interface MailRules {
  blockedSenders: string[]; // emails or @domains never turned into tickets
  skipAutomated: boolean;
  archiveOnClose: boolean;
  importDays: number;
}

export const DEFAULT_RULES: MailRules = {
  blockedSenders: [],
  skipAutomated: true,
  archiveOnClose: true,
  importDays: 14,
};

export const getMailbox = (env: Env) => getSetting<MailboxState | null>(env, "mailbox", null);

async function accessToken(env: Env): Promise<string> {
  const box = await getMailbox(env);
  if (!box) throw new HttpError(409, "The support mailbox is not connected yet (Settings → Connect Gmail).");
  return cachedToken(env, "mailbox_access", async () => {
    const t = await refreshAccessToken(env, await decrypt(env, box.refreshToken));
    return { token: t.access_token, expiresIn: t.expires_in };
  });
}

/**
 * Cloudflare's free plan allows 50 outside requests per run (cron tick or page request). Gmail calls
 * are counted per run so a big import stops cleanly and the next minute's run carries on.
 */
export const GMAIL_BUDGET = 40;
export class GmailBudgetError extends Error {}
const budgets = new WeakMap<object, { used: number }>();
export const gmailCallsLeft = (env: Env) => GMAIL_BUDGET - (budgets.get(env)?.used ?? 0);

export async function gmail<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const b = budgets.get(env) ?? { used: 0 };
  budgets.set(env, b);
  if (b.used >= GMAIL_BUDGET) throw new GmailBudgetError("Gmail request budget for this run is used up");
  b.used++;
  const token = await accessToken(env);
  const res = await fetch(API + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(res.status === 404 ? 404 : 502, `Gmail ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  payload: GmailPart;
}

function blocked(rules: MailRules, email: string): boolean {
  const e = email.toLowerCase();
  return rules.blockedSenders.some((b) => {
    const rule = b.trim().toLowerCase();
    return rule && (rule.startsWith("@") ? e.endsWith(rule) : e === rule);
  });
}

/** Finds the ticket that owns a Gmail thread (a ticket can hold several threads after merges). */
async function ticketForThread(env: Env, threadId: string) {
  return env.DB.prepare(
    `SELECT t.* FROM tickets t WHERE t.id = COALESCE((SELECT ticket_id FROM ticket_threads WHERE thread_id = ?1), (SELECT id FROM tickets WHERE gmail_thread_id = ?1))`,
  )
    .bind(threadId)
    .first<TicketRow>();
}

/** Store one Gmail message on its ticket, creating, merging or reopening the ticket as needed. */
interface ImportOpts {
  agentId?: number | null;
  force?: boolean;
  skipRules?: boolean;
  /** Backfill of older mail: archived threads become closed tickets; no rules, assignment, merging or reopening. */
  historical?: boolean;
}

export async function importMessage(env: Env, id: string, opts: ImportOpts = {}): Promise<{ ticketId: number; created: boolean } | null> {
  const existing = await env.DB.prepare("SELECT ticket_id FROM messages WHERE gmail_message_id = ?")
    .bind(id)
    .first<{ ticket_id: number }>();
  if (existing) return { ticketId: existing.ticket_id, created: false };
  if (!opts.force && (await env.DB.prepare("SELECT 1 FROM skipped_messages WHERE gmail_message_id = ?").bind(id).first())) return null;

  let msg: GmailMessage;
  try {
    msg = await gmail<GmailMessage>(env, `/messages/${id}?format=full`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return skip(env, id, "deleted");
    throw e;
  }
  return storeMessage(env, msg, opts);
}

async function skip(env: Env, id: string, reason: string): Promise<null> {
  await env.DB.prepare("INSERT OR IGNORE INTO skipped_messages (gmail_message_id, reason) VALUES (?, ?)").bind(id, reason).run();
  return null;
}

async function storeMessage(env: Env, msg: GmailMessage, opts: ImportOpts): Promise<{ ticketId: number; created: boolean } | null> {
  const labels = msg.labelIds ?? [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("TRASH")) return opts.historical ? null : skip(env, msg.id, "draft/spam/trash");

  const h = headerMap(msg.payload);
  const box = await getMailbox(env);
  const supportEmail = (box?.email ?? env.SUPPORT_EMAIL).toLowerCase();
  const from = parseAddress(h["from"] ?? "");
  const outbound = from.email === supportEmail || labels.includes("SENT");
  const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };
  const support = await supportSettings(env);

  let ticket = await ticketForThread(env, msg.threadId);

  if (!ticket) {
    // Only inbound customer mail in the inbox starts a ticket
    if (outbound || (!opts.force && !opts.historical && !labels.includes("INBOX"))) return opts.historical ? null : skip(env, msg.id, outbound ? "sent by us" : "not in inbox");
    if (!opts.force && blocked(rules, from.email)) return opts.historical ? null : skip(env, msg.id, "blocked sender");
    if (!opts.force && rules.skipAutomated && isAutomated(h)) return opts.historical ? null : skip(env, msg.id, "newsletter / automated");
  }

  const sentAt = new Date(Number(msg.internalDate)).toISOString();
  const { text, html, attachments } = extractContent(msg.payload);
  const snippet = (msg.snippet ?? text.slice(0, 200)).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  let created = false;
  let mergedIntoExisting = false;

  if (!ticket) {
    // Auto-merge: a new email from someone with a ticket open in the last 24 h joins that ticket
    const excluded = blocked({ ...rules, blockedSenders: support.mergeExclusions }, from.email);
    if (support.autoMerge && !excluded && !opts.historical) {
      const open = await env.DB.prepare(
        `SELECT * FROM tickets WHERE customer_email = ? AND status IN ('open','in_progress','snoozed') AND merged_into IS NULL
           AND last_message_at >= ? ORDER BY last_message_at DESC LIMIT 1`,
      )
        .bind(from.email, new Date(Date.now() - 24 * 3600_000).toISOString())
        .first<TicketRow>();
      if (open) {
        await env.DB.prepare("INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) VALUES (?, ?, ?)").bind(msg.threadId, open.id, h["subject"] ?? null).run();
        await logEvent(env, open.id, "merged", `New email “${(h["subject"] ?? "").slice(0, 80)}” merged automatically`);
        ticket = open;
        mergedIntoExisting = true;
      }
    }
  }

  if (!ticket) {
    const archived = !!opts.historical; // history comes in closed; recent inbox mail is handled by the normal sync
    const row = await env.DB.prepare(
      `INSERT INTO tickets (gmail_thread_id, subject, customer_email, customer_name, status, unread, snippet, created_at, last_message_at, last_inbound_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(gmail_thread_id) DO UPDATE SET gmail_thread_id = excluded.gmail_thread_id RETURNING *`,
    )
      .bind(msg.threadId, h["subject"] || "(no subject)", from.email, from.name, archived ? "closed" : "open", archived ? 0 : 1, snippet, sentAt, sentAt, sentAt)
      .first<TicketRow>();
    ticket = row!;
    await env.DB.prepare("INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) VALUES (?, ?, ?)").bind(msg.threadId, ticket.id, h["subject"] ?? null).run();
    await logEvent(env, ticket.id, "received", opts.historical ? "Imported from Gmail history" : "Ticket created from Gmail");
    created = true;
  }

  const ins = await env.DB.prepare(
    `INSERT INTO messages (ticket_id, gmail_message_id, rfc_message_id, direction, from_email, from_name, to_emails, cc_emails, bcc_emails, subject, sent_at, body_text, body_html, attachments, agent_id, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gmail_message_id) DO NOTHING`,
  )
    .bind(
      ticket.id,
      msg.id,
      h["message-id"] ?? null,
      outbound ? "out" : "in",
      from.email,
      from.name,
      splitAddressList(h["to"] ?? "").join(", "),
      splitAddressList(h["cc"] ?? "").join(", "),
      splitAddressList(h["bcc"] ?? "").join(", "),
      h["subject"] ?? null,
      sentAt,
      text,
      html,
      JSON.stringify(attachments),
      opts.agentId ?? null,
      msg.threadId,
    )
    .run();
  if (!ins.meta.changes) return { ticketId: ticket.id, created: false };

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE tickets SET message_count = message_count + 1,
         last_message_at = MAX(last_message_at, ?1),
         snippet = CASE WHEN ?1 >= last_message_at THEN ?2 ELSE snippet END
       WHERE id = ?3`,
    ).bind(sentAt, snippet, ticket.id),
  ];
  if (outbound) {
    stmts.push(env.DB.prepare("UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?) WHERE id = ? AND created_at <= ?").bind(sentAt, ticket.id, sentAt));
  } else if (!created && !opts.historical) {
    stmts.push(
      env.DB.prepare("UPDATE tickets SET unread = 1, last_inbound_at = MAX(COALESCE(last_inbound_at, ''), ?) WHERE id = ?").bind(sentAt, ticket.id),
    );
  }
  await env.DB.batch(stmts);
  ticket.message_count += 1;

  if (!outbound && !created && !opts.historical) {
    // Reopen on customer reply (spam and deleted tickets stay put)
    if (["in_progress", "snoozed", "closed", "archived"].includes(ticket.status)) {
      await setStatus(env, ticket, "open", null, { source: "customer replied" });
    }
  }

  if (!outbound && !opts.skipRules && !opts.historical) {
    const message = { from: from.email, subject: h["subject"] ?? "", body: text.slice(0, 20000) };
    if (created) {
      const assignee = await pickAssignee(env, support.assignment);
      if (assignee !== null) await assign(env, ticket, assignee, null);
      await runRules(env, "ticket_created", ticket.id, message, (t, m) => sendMacroAutoReply(env, t, m));
    }
    if (!created || mergedIntoExisting) await runRules(env, "customer_message", ticket.id, message, (t, m) => sendMacroAutoReply(env, t, m));
    if (support.aiAutoInsights && aiConfigured(env)) await refreshInsights(env, ticket.id).catch((e) => console.error("AI insights", e));
  }
  return { ticketId: ticket.id, created };
}

/** Summary, sentiment and type for a ticket, saved on it (only when "AI insights on every message" is on). */
async function refreshInsights(env: Env, ticketId: number) {
  const t = await env.DB.prepare("SELECT subject FROM tickets WHERE id = ?").bind(ticketId).first<{ subject: string }>();
  const { results } = await env.DB.prepare("SELECT direction, from_email, sent_at, body_text FROM messages WHERE ticket_id = ? ORDER BY sent_at")
    .bind(ticketId)
    .all<any>();
  const r = await ticketInsights(env, t?.subject ?? "", results.map((m) => ({ direction: m.direction, from: m.from_email, sentAt: m.sent_at, text: m.body_text })));
  await env.DB.prepare("UPDATE tickets SET ai_summary = ?, ai_sentiment = ?, ai_type = ?, ai_updated_at = ? WHERE id = ?")
    .bind(r.summary, r.sentiment, r.type, nowIso(), ticketId)
    .run();
}

/** Sends a saved reply automatically (rules "Auto reply" action). */
export async function sendMacroAutoReply(env: Env, t: TicketRow, macroId: number) {
  const macro = await env.DB.prepare("SELECT body FROM macros WHERE id = ?").bind(macroId).first<{ body: string }>();
  const box = await getMailbox(env);
  if (!macro || !box) return;
  const { results: refs } = await env.DB.prepare(
    "SELECT rfc_message_id, thread_id FROM messages WHERE ticket_id = ? AND rfc_message_id IS NOT NULL ORDER BY sent_at",
  )
    .bind(t.id)
    .all<{ rfc_message_id: string; thread_id: string | null }>();
  const text = renderMacro(macro.body, { customer: { name: t.customer_name, email: t.customer_email }, agent: { name: env.APP_NAME }, storeName: "Tuft the World" });
  const mime = buildMime({
    fromEmail: box.email,
    fromName: env.APP_NAME,
    to: [t.customer_email],
    subject: replySubject(t.subject),
    inReplyTo: refs.at(-1)?.rfc_message_id ?? null,
    references: refs.slice(-20).map((r) => r.rfc_message_id).join(" ") || null,
    text,
  });
  const sent = await sendRaw(env, encodeRaw(mime), refs.at(-1)?.thread_id ?? t.gmail_thread_id);
  await importMessage(env, sent.id, { force: true, skipRules: true });
}

/**
 * Pull new mail. Uses Gmail's history feed after the first run. Works within a per-run request
 * budget: when it runs out, the sync position isn't advanced, so the next run picks up the rest
 * (messages already imported or skipped cost nothing the second time).
 */
export async function syncMailbox(env: Env): Promise<{ imported: number; created: number; closed: number; more: boolean }> {
  const box = await getMailbox(env);
  if (!box) return { imported: 0, created: 0, closed: 0, more: false };
  let imported = 0;
  let created = 0;
  let closed = 0;
  let more = false;
  const support = await supportSettings(env);
  const handle = async (ids: string[]) => {
    for (const id of ids) {
      try {
        const r = await importMessage(env, id);
        if (r) {
          imported++;
          if (r.created) created++;
        }
      } catch (e) {
        if (e instanceof GmailBudgetError) {
          more = true;
          return;
        }
        throw e;
      }
    }
  };

  try {
    const profile = await gmail<{ historyId: string }>(env, "/profile");
    let needsFull = !box.historyId;

    if (box.historyId) {
      try {
        const ids: string[] = [];
        const archivedThreads = new Set<string>();
        let pageToken: string | undefined;
        do {
          const q = new URLSearchParams({ startHistoryId: box.historyId });
          q.append("historyTypes", "messageAdded");
          q.append("historyTypes", "labelRemoved");
          if (pageToken) q.set("pageToken", pageToken);
          const page = await gmail<{
            history?: {
              messagesAdded?: { message: { id: string } }[];
              labelsRemoved?: { message: { id: string; threadId: string }; labelIds: string[] }[];
            }[];
            nextPageToken?: string;
          }>(env, `/history?${q}`);
          for (const h of page.history ?? []) {
            for (const m of h.messagesAdded ?? []) ids.push(m.message.id);
            for (const r of h.labelsRemoved ?? []) if (r.labelIds.includes("INBOX")) archivedThreads.add(r.message.threadId);
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
        await handle([...new Set(ids)]);
        // Archived in Gmail → close the ticket (if it's still open there)
        if (support.closeOnGmailArchive) {
          for (const threadId of archivedThreads) {
            const t = await ticketForThread(env, threadId);
            if (t && ["open", "in_progress"].includes(t.status)) {
              await setStatus(env, t, "closed", null, { source: "archived in Gmail" });
              closed++;
            }
          }
        }
      } catch (e) {
        // History IDs expire after about a week offline — fall back to a recent scan
        if (e instanceof HttpError && e.status === 404) needsFull = true;
        else if (e instanceof GmailBudgetError) more = true;
        else throw e;
      }
    }

    if (needsFull && !more) {
      const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };
      const ids: string[] = [];
      let pageToken: string | undefined;
      try {
        do {
          const q = new URLSearchParams({ q: `in:inbox newer_than:${rules.importDays}d`, maxResults: "500" });
          if (pageToken) q.set("pageToken", pageToken);
          const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(env, `/messages?${q}`);
          ids.push(...(page.messages ?? []).map((m) => m.id));
          pageToken = page.nextPageToken;
        } while (pageToken && ids.length < 2000);
      } catch (e) {
        if (!(e instanceof GmailBudgetError)) throw e;
        more = true;
      }
      if (!more) await handle(ids.reverse()); // oldest first so threads build in order
    }

    // Only move the sync position once everything up to now is in
    const next = more ? box.historyId : needsFull || box.historyId ? profile.historyId : box.historyId;
    await setSetting(env, "mailbox", {
      ...box,
      historyId: next,
      lastSyncAt: nowIso(),
      lastError: null,
      catchingUp: more,
    });
  } catch (e) {
    await setSetting(env, "mailbox", { ...box, lastSyncAt: nowIso(), lastError: String((e as Error).message ?? e) });
    throw e;
  }
  return { imported, created, closed, more };
}

export async function sendRaw(env: Env, raw: string, threadId: string | null): Promise<{ id: string; threadId: string }> {
  return gmail(env, "/messages/send", {
    method: "POST",
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
}

export async function getAttachment(env: Env, messageId: string, attachmentId: string): Promise<string> {
  const r = await gmail<{ data: string }>(env, `/messages/${messageId}/attachments/${attachmentId}`);
  return r.data;
}

export async function modifyThread(env: Env, threadId: string, add: string[], remove: string[]) {
  await gmail(env, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
}

// ---------------------------------------------------------------- History backfill

export interface BackfillJob {
  days: number;
  pageToken?: string | null;
  threads: number;
  created: number;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

/**
 * Imports older Gmail threads (inbox and archived) a few at a time, so history counts toward
 * customer history and analytics. Runs from the minute cron until it reaches the end.
 * Each thread is one Gmail request, which keeps every run inside the Workers request limits.
 */
export async function runBackfill(env: Env, batch = 25): Promise<BackfillJob | null> {
  const job = await getSetting<BackfillJob | null>(env, "backfill", null);
  if (!job || job.finishedAt) return job;
  batch = Math.min(batch, gmailCallsLeft(env) - 2); // one list call + one thread per conversation
  if (batch < 1) return job;
  try {
    const q = new URLSearchParams({ q: `newer_than:${job.days}d -in:spam -in:trash -in:drafts -in:chats`, maxResults: String(batch) });
    if (job.pageToken) q.set("pageToken", job.pageToken);
    const page = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(env, `/threads?${q}`);
    for (const th of page.threads ?? []) {
      const thread = await gmail<{ messages?: GmailMessage[] }>(env, `/threads/${th.id}?format=full`).catch((e) => {
        if (e instanceof HttpError && e.status === 404) return { messages: [] };
        throw e;
      });
      const msgs = (thread.messages ?? []).sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      const known = new Set(
        (await env.DB.prepare(`SELECT gmail_message_id FROM messages WHERE gmail_message_id IN (${msgs.map(() => "?").join(",") || "''"})`).bind(...msgs.map((m) => m.id)).all<{ gmail_message_id: string }>()).results.map((r) => r.gmail_message_id),
      );
      let ticketId: number | null = null;
      for (const m of msgs) {
        if (known.has(m.id)) continue;
        const r = await storeMessage(env, m, { historical: true, skipRules: true });
        if (r?.created) job.created++;
        if (r) ticketId = r.ticketId;
      }
      // Archived conversations count as resolved at their last message
      if (ticketId) {
        await env.DB.prepare(
          `UPDATE tickets SET closed_at = COALESCE(closed_at, last_message_at), resolved_at = COALESCE(resolved_at, last_message_at) WHERE id = ? AND status = 'closed'`,
        ).bind(ticketId).run();
      }
      job.threads++;
    }
    job.pageToken = page.nextPageToken ?? null;
    if (!page.nextPageToken) job.finishedAt = nowIso();
    job.error = null;
  } catch (e) {
    // Out of budget mid-page: the threads done so far are saved; this page is re-listed next run
    if (!(e instanceof GmailBudgetError)) job.error = String((e as Error).message ?? e).slice(0, 300);
  }
  await setSetting(env, "backfill", job);
  return job;
}
