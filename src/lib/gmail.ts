import type { Env } from "../env";
import { refreshAccessToken } from "./google";
import { extractContent, headerMap, isAutomated, type GmailPart } from "./mime";
import { HttpError, cachedToken, decrypt, getSetting, nowIso, parseAddress, setSetting, splitAddressList } from "./util";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface MailboxState {
  email: string;
  refreshToken: string; // encrypted
  historyId?: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string | null;
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

export async function gmail<T = any>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
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

/** Store one Gmail message on its ticket, creating or reopening the ticket as needed. */
export async function importMessage(
  env: Env,
  id: string,
  opts: { agentId?: number | null; force?: boolean } = {},
): Promise<{ ticketId: number; created: boolean } | null> {
  const existing = await env.DB.prepare("SELECT ticket_id FROM messages WHERE gmail_message_id = ?")
    .bind(id)
    .first<{ ticket_id: number }>();
  if (existing) return { ticketId: existing.ticket_id, created: false };

  let msg: GmailMessage;
  try {
    msg = await gmail<GmailMessage>(env, `/messages/${id}?format=full`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null; // deleted since
    throw e;
  }
  const labels = msg.labelIds ?? [];
  if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("TRASH")) return null;

  const h = headerMap(msg.payload);
  const box = await getMailbox(env);
  const supportEmail = (box?.email ?? env.SUPPORT_EMAIL).toLowerCase();
  const from = parseAddress(h["from"] ?? "");
  const outbound = from.email === supportEmail || labels.includes("SENT");
  const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };

  let ticket = await env.DB.prepare("SELECT id, status FROM tickets WHERE gmail_thread_id = ?")
    .bind(msg.threadId)
    .first<{ id: number; status: string }>();

  if (!ticket) {
    // Only inbound customer mail in the inbox starts a ticket
    if (outbound || (!opts.force && !labels.includes("INBOX"))) return null;
    if (!opts.force && (blocked(rules, from.email) || (rules.skipAutomated && isAutomated(h)))) return null;
  }

  const sentAt = new Date(Number(msg.internalDate)).toISOString();
  const { text, html, attachments } = extractContent(msg.payload);
  const snippet = (msg.snippet ?? text.slice(0, 200)).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  let created = false;

  if (!ticket) {
    const row = await env.DB.prepare(
      `INSERT INTO tickets (gmail_thread_id, subject, customer_email, customer_name, status, unread, snippet, created_at, last_message_at, last_inbound_at)
       VALUES (?, ?, ?, ?, 'open', 1, ?, ?, ?, ?)
       ON CONFLICT(gmail_thread_id) DO UPDATE SET gmail_thread_id = excluded.gmail_thread_id RETURNING id, status`,
    )
      .bind(msg.threadId, h["subject"] || "(no subject)", from.email, from.name, snippet, sentAt, sentAt, sentAt)
      .first<{ id: number; status: string }>();
    ticket = row!;
    created = true;
  }

  const ins = await env.DB.prepare(
    `INSERT INTO messages (ticket_id, gmail_message_id, rfc_message_id, direction, from_email, from_name, to_emails, cc_emails, subject, sent_at, body_text, body_html, attachments, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gmail_message_id) DO NOTHING`,
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
      h["subject"] ?? null,
      sentAt,
      text,
      html,
      JSON.stringify(attachments),
      opts.agentId ?? null,
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
  if (!outbound && !created) {
    stmts.push(
      env.DB.prepare(
        "UPDATE tickets SET unread = 1, last_inbound_at = MAX(COALESCE(last_inbound_at, ''), ?) WHERE id = ?",
      ).bind(sentAt, ticket.id),
    );
    if (ticket.status !== "open") {
      stmts.push(
        env.DB.prepare("UPDATE tickets SET status = 'open', closed_at = NULL WHERE id = ?").bind(ticket.id),
        env.DB.prepare("INSERT INTO events (ticket_id, kind, detail) VALUES (?, 'reopened', 'Customer replied')").bind(ticket.id),
      );
    }
  }
  await env.DB.batch(stmts);
  return { ticketId: ticket.id, created };
}

/** Pull new mail. Uses Gmail's history feed after the first run. */
export async function syncMailbox(env: Env): Promise<{ imported: number; created: number }> {
  const box = await getMailbox(env);
  if (!box) return { imported: 0, created: 0 };
  let imported = 0;
  let created = 0;
  const handle = async (ids: string[]) => {
    for (const id of ids) {
      const r = await importMessage(env, id);
      if (r) {
        imported++;
        if (r.created) created++;
      }
    }
  };

  try {
    const profile = await gmail<{ historyId: string }>(env, "/profile");
    let needsFull = !box.historyId;

    if (box.historyId) {
      try {
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
          const q = new URLSearchParams({ startHistoryId: box.historyId, historyTypes: "messageAdded" });
          if (pageToken) q.set("pageToken", pageToken);
          const page = await gmail<{
            history?: { messagesAdded?: { message: { id: string } }[] }[];
            nextPageToken?: string;
          }>(env, `/history?${q}`);
          for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) ids.push(m.message.id);
          pageToken = page.nextPageToken;
        } while (pageToken);
        await handle([...new Set(ids)]);
      } catch (e) {
        // History IDs expire after about a week offline — fall back to a recent scan
        if (e instanceof HttpError && e.status === 404) needsFull = true;
        else throw e;
      }
    }

    if (needsFull) {
      const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ q: `in:inbox newer_than:${rules.importDays}d`, maxResults: "100" });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(env, `/messages?${q}`);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < 500);
      await handle(ids.reverse()); // oldest first so threads build in order
    }

    await setSetting(env, "mailbox", { ...box, historyId: profile.historyId, lastSyncAt: nowIso(), lastError: null });
  } catch (e) {
    await setSetting(env, "mailbox", { ...box, lastSyncAt: nowIso(), lastError: String((e as Error).message ?? e) });
    throw e;
  }
  return { imported, created };
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
