// Live chat on the store website. Every chat is a ticket (channel "chat"); its messages sit in
// `messages` with kind chat (customer or teammate), chat_ai (the AI) or chat_system (status lines).
// The AI answers first (or drafts for a teammate to send); when a person is needed and nobody picks
// it up, or the customer asks, the chat moves to email: the transcript goes out from the support
// mailbox and replies thread back into the same ticket.
import type { Env } from "../env";
import { aiConfigured, chatAnswer, type ChatAnswer, type ChatCards } from "./ai";
import { buildMime, encodeRaw, textToHtml } from "./mime";
import { getMailbox, importMessage, sendRaw } from "./gmail";
import { customerProfile, findOrderByName, type ShopifyOrder } from "./shopify";
import { logEvent, setStatus, getTicket } from "./support";
import { HttpError, getSetting, nowIso } from "./util";

export type ChatState = "ai" | "waiting" | "agent" | "email" | "ended";
export type AiMode = "off" | "draft" | "auto";

export interface DayHours { on: boolean; start: string; end: string }
export interface ChatSettings {
  enabled: boolean;
  aiMode: AiMode;
  title: string;
  greeting: string;
  offlineMessage: string;
  color: string;
  position: "right" | "left";
  timezone: string;
  hours: DayHours[]; // Sunday first
  handoffMinutes: number; // during hours: move to email if nobody replies in this long
  maxAiReplies: number;
  allowPhotos: boolean;
  origins: string[]; // sites allowed to embed the chat
}

const WEEKDAY: DayHours = { on: true, start: "09:00", end: "17:00" };
const OFF: DayHours = { on: false, start: "09:00", end: "17:00" };
export const DEFAULT_CHAT: ChatSettings = {
  enabled: false,
  aiMode: "draft",
  title: "Chat with Tuft the World",
  greeting: "Hi! Ask us anything about tufting, your order, or fixing your gun.",
  offlineMessage: "We're out of the office right now (Mon–Fri, 9–5 Eastern). Leave a message and we'll reply by email.",
  color: "#1f3b33",
  position: "right",
  timezone: "America/New_York",
  hours: [OFF, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, OFF],
  handoffMinutes: 3,
  maxAiReplies: 12,
  allowPhotos: true,
  origins: ["https://tufttheworld.com", "https://www.tufttheworld.com", "https://tufttheworld.myshopify.com"],
};

const hhmm = (v: unknown, d: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);

/** Settings from the browser, cleaned. */
export function cleanChatSettings(raw: any, cur: ChatSettings = DEFAULT_CHAT): ChatSettings {
  const n = { ...cur, ...(raw ?? {}) };
  const hours = Array.isArray(n.hours) && n.hours.length === 7
    ? n.hours.map((d: any, i: number) => ({ on: !!d?.on, start: hhmm(d?.start, cur.hours[i].start), end: hhmm(d?.end, cur.hours[i].end) }))
    : cur.hours;
  let tz = String(n.timezone || DEFAULT_CHAT.timezone);
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = DEFAULT_CHAT.timezone; }
  return {
    enabled: !!n.enabled,
    aiMode: (["off", "draft", "auto"] as const).includes(n.aiMode) ? n.aiMode : "draft",
    title: String(n.title ?? "").slice(0, 60) || DEFAULT_CHAT.title,
    greeting: String(n.greeting ?? "").slice(0, 300),
    offlineMessage: String(n.offlineMessage ?? "").slice(0, 300) || DEFAULT_CHAT.offlineMessage,
    color: /^#[0-9a-f]{6}$/i.test(n.color) ? n.color : DEFAULT_CHAT.color,
    position: n.position === "left" ? "left" : "right",
    timezone: tz,
    hours,
    handoffMinutes: Math.min(60, Math.max(1, Math.round(Number(n.handoffMinutes) || 3))),
    maxAiReplies: Math.min(50, Math.max(1, Math.round(Number(n.maxAiReplies) || 12))),
    allowPhotos: n.allowPhotos !== false,
    origins: (Array.isArray(n.origins) ? n.origins : String(n.origins ?? "").split(/[\s,]+/))
      .map((o: string) => String(o).trim().replace(/\/+$/, ""))
      .filter((o: string) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o))
      .slice(0, 20),
  };
}

export const chatSettings = async (env: Env): Promise<ChatSettings> => cleanChatSettings(await getSetting<Partial<ChatSettings>>(env, "chat", {}));

/** Is someone in the office right now (by the configured hours and time zone)? */
export function isOpen(s: Pick<ChatSettings, "hours" | "timezone">, now = new Date()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const h = s.hours[day];
  if (!h?.on) return false;
  const t = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  return t >= h.start && t < h.end;
}

/** "Mon–Fri, 9am–5pm" style summary for the widget and the AI. */
export function hoursText(s: Pick<ChatSettings, "hours" | "timezone">): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  };
  const groups: { from: number; to: number; key: string }[] = [];
  s.hours.forEach((d, i) => {
    if (!d.on) return;
    const key = `${d.start}-${d.end}`;
    const last = groups.at(-1);
    if (last && last.key === key && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, key });
  });
  if (!groups.length) return "by email";
  const zone = s.timezone === "America/New_York" ? "Eastern" : s.timezone.split("/").pop()!.replace(/_/g, " ");
  return groups.map((g) => `${names[g.from]}${g.to > g.from ? `–${names[g.to]}` : ""} ${fmt(g.key.split("-")[0])}–${fmt(g.key.split("-")[1])}`).join(", ") + ` ${zone}`;
}

export interface ChatRow {
  id: string;
  token: string;
  ticket_id: number;
  email: string;
  name: string | null;
  state: ChatState;
  page_url: string | null;
  waiting_since: string | null;
  visitor_seen_at: string | null;
  visitor_typing_at: string | null;
  agent_seen_at: string | null;
  agent_typing_at: string | null;
  ai_replies: number;
  ai_draft: string | null;
  verify_email?: string | null;
  verify_code?: string | null;
  verify_expires?: string | null;
  verify_attempts?: number;
  verify_sends?: number;
  verified_emails?: string;
  created_at: string;
  updated_at: string;
}

const randomId = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hashIp(ip: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`chat:${ip}`));
  return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const loadChat = (env: Env, id: string) => env.DB.prepare("SELECT * FROM chats WHERE id = ?").bind(id).first<ChatRow>();
export const chatForTicket = (env: Env, ticketId: number) =>
  env.DB.prepare("SELECT * FROM chats WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1").bind(ticketId).first<ChatRow>();

/** The widget's chat, checked against its secret. */
export async function authedChat(env: Env, id: string, token: string | undefined | null) {
  const chat = await loadChat(env, id);
  if (!chat || !token || chat.token !== token) throw new HttpError(404, "Chat not found");
  return chat;
}

export interface ChatFile { filename: string; mime: string; data: string }
const MAX_FILE = 1_600_000; // base64 chars (~1.2 MB image)

async function saveFiles(env: Env, chatId: string, files: ChatFile[] | undefined) {
  const out: { id: string; filename: string; mimeType: string; size: number }[] = [];
  for (const f of (files ?? []).slice(0, 4)) {
    if (!/^image\/(jpeg|png|webp|gif)$/.test(f.mime)) throw new HttpError(415, "Only photos can be sent in chat");
    const data = String(f.data).replace(/^data:[^,]+,/, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, "That photo couldn't be read");
    if (data.length > MAX_FILE) throw new HttpError(413, "That photo is too large");
    const size = Math.round(data.length * 0.75);
    const r = await env.DB.prepare("INSERT INTO chat_files (chat_id, filename, mime, size, data) VALUES (?, ?, ?, ?, ?) RETURNING id")
      .bind(chatId, String(f.filename || "photo.jpg").slice(0, 120), f.mime, size, data)
      .first<{ id: number }>();
    out.push({ id: `c${r!.id}`, filename: String(f.filename || "photo.jpg").slice(0, 120), mimeType: f.mime, size });
  }
  return out;
}

export type ChatKind = "chat" | "chat_ai" | "chat_system";

/** Adds a message to the chat's ticket and bumps the ticket. */
export async function addChatMessage(
  env: Env,
  chat: ChatRow,
  m: { kind: ChatKind; direction: "in" | "out"; text: string; files?: ChatFile[]; agentId?: number | null; fromName?: string | null; extra?: ChatCards | null },
): Promise<number> {
  const at = nowIso();
  const attachments = await saveFiles(env, chat.id, m.files);
  const text = m.text.trim().slice(0, 4000);
  const fromEmail = m.direction === "in" ? chat.email : m.kind === "chat_ai" ? "ai@chat" : m.kind === "chat_system" ? "system@chat" : "agent@chat";
  const r = await env.DB.prepare(
    `INSERT INTO messages (ticket_id, direction, from_email, from_name, to_emails, subject, sent_at, body_text, body_html, attachments, agent_id, kind, extra)
     VALUES (?, ?, ?, ?, '', NULL, ?, ?, NULL, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(chat.ticket_id, m.direction, fromEmail, m.fromName ?? (m.direction === "in" ? chat.name : null), at, text, JSON.stringify(attachments), m.agentId ?? null, m.kind,
      m.extra && (m.extra.articles.length || m.extra.products.length) ? JSON.stringify(m.extra) : null)
    .first<{ id: number }>();
  const snippet = (text || (attachments.length ? "📷 Photo" : "")).slice(0, 200);
  if (m.kind !== "chat_system") {
    await env.DB.prepare(
      `UPDATE tickets SET message_count = message_count + 1, last_message_at = ?1, snippet = ?2
         ${m.direction === "in" ? ", last_inbound_at = ?1, unread = 1" : ""} WHERE id = ?3`,
    ).bind(at, snippet, chat.ticket_id).run();
  }
  await env.DB.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").bind(at, chat.id).run();
  return r!.id;
}

export async function setChatState(env: Env, chat: ChatRow, state: ChatState) {
  if (chat.state === state) return;
  const waiting = state === "waiting" ? nowIso() : null;
  await env.DB.prepare("UPDATE chats SET state = ?, waiting_since = ?, updated_at = ? WHERE id = ?").bind(state, waiting, nowIso(), chat.id).run();
  chat.state = state;
  chat.waiting_since = waiting;
}

/** A new chat from the widget: a ticket, the chat, the first message. */
export async function startChat(
  env: Env,
  input: { name: string; email: string; message: string; page?: string | null; ipHash: string; files?: ChatFile[] },
): Promise<ChatRow> {
  const at = nowIso();
  const first = input.message.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  const subject = `Chat: ${first.length > 70 ? `${first.slice(0, 67)}…` : first || "New chat"}`;
  const t = await env.DB.prepare(
    `INSERT INTO tickets (subject, customer_email, customer_name, status, unread, snippet, created_at, last_message_at, last_inbound_at, channel, tags)
     VALUES (?, ?, ?, 'open', 1, '', ?, ?, ?, 'chat', '["Chat"]') RETURNING id`,
  ).bind(subject, input.email, input.name || null, at, at, at).first<{ id: number }>();
  const chat: ChatRow = {
    id: randomId(12), token: randomId(24), ticket_id: t!.id, email: input.email, name: input.name || null, state: "ai",
    page_url: input.page ?? null, waiting_since: null, visitor_seen_at: at, visitor_typing_at: null, agent_seen_at: null, agent_typing_at: null,
    ai_replies: 0, ai_draft: null, created_at: at, updated_at: at,
  };
  await env.DB.prepare(
    "INSERT INTO chats (id, token, ticket_id, email, name, state, page_url, ip_hash, visitor_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?)",
  ).bind(chat.id, chat.token, chat.ticket_id, chat.email, chat.name, chat.page_url, input.ipHash, at, at, at).run();
  await logEvent(env, chat.ticket_id, "received", `Chat started${input.page ? ` on ${input.page.slice(0, 200)}` : ""}`);
  await addChatMessage(env, chat, { kind: "chat", direction: "in", text: input.message, files: input.files });
  return chat;
}

/** Messages after `after` (by id), shaped for the widget or the ticket page. */
export async function chatMessages(env: Env, chat: ChatRow, after = 0) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.direction, m.kind, m.from_name, m.body_text, m.attachments, m.sent_at, m.extra, a.name AS agent_name
     FROM messages m LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.ticket_id = ? AND m.kind IS NOT NULL AND m.id > ? ORDER BY m.id LIMIT 200`,
  ).bind(chat.ticket_id, after).all<any>();
  return results.map((m) => ({
    id: m.id as number,
    from: m.direction === "in" ? "visitor" : m.kind === "chat_ai" ? "ai" : m.kind === "chat_system" ? "system" : "agent",
    name: m.direction === "in" ? m.from_name : m.kind === "chat" ? String(m.agent_name ?? m.from_name ?? "Tuft the World").split(" ")[0] : null,
    text: m.body_text as string,
    files: (JSON.parse(m.attachments || "[]") as { id: string; filename: string; mimeType: string }[]).map((f) => ({ id: f.id, name: f.filename, mime: f.mimeType })),
    at: m.sent_at as string,
    cards: m.extra ? (JSON.parse(m.extra) as ChatCards) : null,
  }));
}

/** Cards as plain lines, for emails and teammates' drafts. */
export function cardsText(c: ChatCards | null | undefined): string {
  if (!c) return "";
  return [
    c.articles.length ? `Read more:\n${c.articles.map((a) => `• ${a.title}: ${a.url}`).join("\n")}` : "",
    c.products.length ? `Products:\n${c.products.map((p) => `• ${p.title} (${p.price}): ${p.url}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** The plain-text transcript for the email hand-off. */
async function transcript(env: Env, chat: ChatRow) {
  const msgs = await chatMessages(env, chat);
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return msgs
    .filter((m) => m.from !== "system")
    .map((m) => {
      const who = m.from === "visitor" ? chat.name || "You" : m.from === "ai" ? "Tuft the World (AI assistant)" : `${m.name ?? "Tuft the World"} (Tuft the World)`;
      const cards = cardsText(m.cards);
      return `${who} · ${time(m.at)}\n${m.text}${cards ? `\n\n${cards}` : ""}${m.files.length ? `\n[${m.files.length} photo${m.files.length > 1 ? "s" : ""}]` : ""}`;
    })
    .join("\n\n");
}

/**
 * Moves a chat to email: the transcript (and optionally a teammate's reply on top) goes to the
 * customer from the support mailbox, and their replies thread into the same ticket.
 */
export async function moveChatToEmail(env: Env, chat: ChatRow, opts: { reason: string; lead?: string; agentId?: number | null; fromName?: string }) {
  if (chat.state === "email") return;
  const box = await getMailbox(env);
  const intro = opts.lead?.trim()
    || "Thanks for chatting with us! We've moved our conversation to email so we can follow up properly. Just reply to this email — photos and videos are welcome.";
  if (box) {
    const subject = "Your chat with Tuft the World";
    const log = await transcript(env, chat);
    const text = `${intro}\n\n— Your chat with us —\n\n${log}`;
    const html = `${textToHtml(intro)}<hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="color:#666;font-size:13px">Your chat with us</p>${textToHtml(log)}`;
    const mime = buildMime({ fromEmail: box.email, fromName: opts.fromName || env.APP_NAME, to: [chat.email], subject, text, html });
    const sent = await sendRaw(env, encodeRaw(mime), null);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject) VALUES (?, ?, ?)").bind(sent.threadId, chat.ticket_id, subject),
      env.DB.prepare("UPDATE tickets SET gmail_thread_id = COALESCE(gmail_thread_id, ?) WHERE id = ?").bind(sent.threadId, chat.ticket_id),
    ]);
    await importMessage(env, sent.id, { force: true, skipRules: true, agentId: opts.agentId ?? undefined });
  }
  await setChatState(env, chat, "email");
  await env.DB.prepare("UPDATE chats SET ai_draft = NULL WHERE id = ?").bind(chat.id).run();
  await addChatMessage(env, chat, {
    kind: "chat_system",
    direction: "out",
    text: box
      ? `We've moved this conversation to email. Watch for a message at ${chat.email} — just reply there, photos welcome.`
      : `We'll reply by email at ${chat.email}.`,
  });
  const t = await getTicket(env, chat.ticket_id);
  if (t) {
    if (opts.lead) await setStatus(env, t, "in_progress", opts.agentId ?? null, { source: "chat moved to email" });
    else {
      await setStatus(env, t, "open", null, { source: "chat moved to email" });
      await env.DB.prepare("UPDATE tickets SET unread = 1 WHERE id = ?").bind(t.id).run();
    }
  }
  await logEvent(env, chat.ticket_id, "chat_email", opts.reason, opts.agentId ?? null);
}

const ORDER_REF = /#?\s?(\d{4,7}(?:-[A-Z]{1,4})?)\b/gi;

export const provenEmails = (chat: ChatRow): string[] => {
  try { return JSON.parse(chat.verified_emails || "[]"); } catch { return []; }
};

/**
 * Orders the AI may talk about: every recent order for an email the customer proved with a code,
 * plus orders they named by number that were placed with the chat's email (two factors).
 */
async function verifiedOrders(env: Env, chat: ChatRow, texts: string[]): Promise<{ orders: unknown[]; mismatched: string[] }> {
  const refs = [...new Set(Array.from(texts.join("\n").matchAll(ORDER_REF), (m) => m[1].toUpperCase()))].slice(-2);
  const proven = provenEmails(chat);
  const allowed = new Set([chat.email.toLowerCase(), ...proven]);
  const orders: unknown[] = [];
  const seen = new Set<string>();
  const mismatched: string[] = [];
  for (const email of proven.slice(0, 2)) {
    const { orders: theirs } = await customerProfile(env, email).catch(() => ({ orders: [] as ShopifyOrder[] }));
    for (const o of theirs.slice(0, 6)) if (!seen.has(o.name)) { seen.add(o.name); orders.push(shapeOrder(o)); }
  }
  for (const ref of refs) {
    let o: ShopifyOrder | null = null;
    try {
      o = await findOrderByName(env, ref);
    } catch {
      continue;
    }
    if (!o || seen.has(o.name)) continue;
    if (!allowed.has((o.email ?? "").toLowerCase())) {
      mismatched.push(o.name);
      continue;
    }
    seen.add(o.name);
    orders.push(shapeOrder(o));
  }
  return { orders, mismatched };
}

/** What the AI sees of an order (no addresses or payment details). */
function shapeOrder(o: ShopifyOrder) {
  return {
      name: o.name,
      placed: o.createdAt,
      payment: o.displayFinancialStatus,
      fulfillment: o.displayFulfillmentStatus,
      cancelled: !!o.cancelledAt,
      items: o.lineItems.nodes.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`),
      shipping: o.shippingLines?.nodes?.[0]?.title,
      tracking: (o.fulfillments ?? []).flatMap((f: any) => (f.trackingInfo ?? []).map((t: any) => ({ status: f.displayStatus, company: t.company, number: t.number, url: t.url }))),
  };
}

// ---- Proving an email with a one-time code (so the AI can look up orders without an order number)

const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/;
const CODE_MINUTES = 15;
const mask = (email: string) => email.replace(/^(.)(.*)(@.*)$/, (_m, a: string, b: string, d: string) => `${a}${"•".repeat(Math.min(6, Math.max(2, b.length)))}${d}`);
async function hashCode(chatId: string, code: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${chatId}:${code}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Emails a 6-digit code to `email`. Returns false when it can't (limit reached, no mailbox, bad address). */
export async function sendVerifyCode(env: Env, chat: ChatRow, email: string): Promise<boolean> {
  email = email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || provenEmails(chat).includes(email)) return false;
  if ((chat.verify_sends ?? 0) >= 3) {
    await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: "We've sent the most codes we can for this chat — a teammate can help instead." });
    return false;
  }
  const box = await getMailbox(env);
  if (!box) return false;
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const text = `Your Tuft the World chat code is ${code}\n\nType it into the chat on our website to see your orders. It works for ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
  const mime = buildMime({ fromEmail: box.email, fromName: env.APP_NAME, to: [email], subject: `Your chat code: ${code}`, text });
  await sendRaw(env, encodeRaw(mime), null);
  await env.DB.prepare("UPDATE chats SET verify_email = ?, verify_code = ?, verify_expires = ?, verify_attempts = 0, verify_sends = verify_sends + 1 WHERE id = ?")
    .bind(email, await hashCode(chat.id, code), new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(), chat.id).run();
  chat.verify_email = email;
  chat.verify_sends = (chat.verify_sends ?? 0) + 1;
  await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: `We emailed a 6-digit code to ${mask(email)}. Type it here to look up your orders (check spam if it's not there in a minute).` });
  await logEvent(env, chat.ticket_id, "chat_verify", `Code sent to ${email}`);
  return true;
}

/**
 * A customer message that might be the code. "ok" proves the email; "bad"/"locked" mean it didn't
 * match; null means it isn't a code (or none is pending) and the message is handled normally.
 */
export async function checkVerifyCode(env: Env, chat: ChatRow, text: string): Promise<"ok" | "bad" | "locked" | null> {
  const m = /^\D{0,12}(\d{3})\s?-?(\d{3})\D{0,12}$/.exec(text.trim());
  if (!m || !chat.verify_code || !chat.verify_email) return null;
  if (!chat.verify_expires || Date.parse(chat.verify_expires) < Date.now()) {
    await env.DB.prepare("UPDATE chats SET verify_code = NULL WHERE id = ?").bind(chat.id).run();
    return "locked";
  }
  if ((await hashCode(chat.id, m[1] + m[2])) !== chat.verify_code) {
    const tries = (chat.verify_attempts ?? 0) + 1;
    await env.DB.prepare(`UPDATE chats SET verify_attempts = ?${tries >= 5 ? ", verify_code = NULL" : ""} WHERE id = ?`).bind(tries, chat.id).run();
    return tries >= 5 ? "locked" : "bad";
  }
  const proven = [...new Set([...provenEmails(chat), chat.verify_email])];
  await env.DB.prepare("UPDATE chats SET verified_emails = ?, verify_code = NULL, verify_expires = NULL WHERE id = ?").bind(JSON.stringify(proven), chat.id).run();
  chat.verified_emails = JSON.stringify(proven);
  chat.verify_code = null;
  await logEvent(env, chat.ticket_id, "chat_verify", `Customer proved ${chat.verify_email}`);
  return "ok";
}

/** The last few photos the customer sent (for the AI to look at). */
async function recentPhotos(env: Env, chat: ChatRow) {
  const { results } = await env.DB.prepare("SELECT mime, data FROM chat_files WHERE chat_id = ? ORDER BY id DESC LIMIT 3").bind(chat.id).all<{ mime: string; data: string }>();
  return results.reverse();
}

/** The AI's next answer for this chat (not sent anywhere yet). */
export async function aiAnswerFor(env: Env, chat: ChatRow, s: ChatSettings): Promise<ChatAnswer> {
  const msgs = await chatMessages(env, chat);
  const visitorTexts = msgs.filter((m) => m.from === "visitor").map((m) => m.text);
  const { orders, mismatched } = await verifiedOrders(env, chat, visitorTexts).catch(() => ({ orders: [], mismatched: [] as string[] }));
  const pending = chat.verify_code && chat.verify_expires && Date.parse(chat.verify_expires) > Date.now() ? chat.verify_email ?? null : null;
  return chatAnswer(env, {
    customerName: chat.name,
    chatEmail: chat.email,
    verifiedEmails: provenEmails(chat),
    codePending: pending,
    open: isOpen(s),
    hours: hoursText(s),
    transcript: msgs.filter((m) => m.from !== "system").map((m) => ({ from: m.from as "visitor" | "ai" | "agent", text: m.text, photos: m.files.length })),
    orders,
    mismatched,
    photos: await recentPhotos(env, chat),
    page: chat.page_url,
  });
}

const SAY_WAITING = "Thanks! I've let our team know — someone will be with you in a moment.";

/** After each customer message: the AI answers (or drafts), or the chat waits for / moves to a person. */
export async function respond(env: Env, chatId: string) {
  const chat = await loadChat(env, chatId);
  if (!chat || chat.state === "email" || chat.state === "ended" || chat.state === "agent") return;
  const s = await chatSettings(env);
  const open = isOpen(s);
  const toPerson = async (why: string) => {
    if (!open) return moveChatToEmail(env, chat, { reason: `${why} — outside chat hours` });
    if (chat.state !== "waiting") {
      await setChatState(env, chat, "waiting");
      const t = await getTicket(env, chat.ticket_id);
      if (t && t.status !== "open") await setStatus(env, t, "open", null, { source: "chat needs a person" });
      await logEvent(env, chat.ticket_id, "chat_waiting", why);
    }
  };

  if (s.aiMode === "off" || !aiConfigured(env)) {
    if (open && chat.state !== "waiting") await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: SAY_WAITING });
    return toPerson("Customer is waiting for a reply");
  }

  if (chat.ai_replies >= s.maxAiReplies) return toPerson("The AI reached its reply limit for this chat");

  const lastIn = () => env.DB.prepare("SELECT MAX(id) AS id FROM messages WHERE ticket_id = ? AND kind = 'chat' AND direction = 'in'").bind(chat.ticket_id).first<{ id: number }>();
  const before = (await lastIn())?.id;
  let ans: ChatAnswer;
  try {
    ans = await aiAnswerFor(env, chat, s);
    // The customer wrote again while this was thinking: that message's answer covers both
    if ((await lastIn())?.id !== before) return;
  } catch (e) {
    console.error("chat AI", e);
    if (open && chat.state !== "waiting") await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: SAY_WAITING });
    return toPerson("The AI couldn't answer");
  }

  // Looking up orders by email: the code goes out right away (whoever answers, the customer needs it)
  const sendCode = () => (ans.verify_email ? sendVerifyCode(env, chat, ans.verify_email).catch((e) => { console.error("chat code", e); return false; }) : Promise.resolve(false));

  if (s.aiMode === "draft") {
    const codeSent = await sendCode();
    // A teammate reads the draft and sends it (or writes their own)
    // Teammates send drafts as plain text, so the article and product links go into the text
    const cards = cardsText(ans.cards);
    const draft = { ...ans, reply: cards ? `${ans.reply}\n\n${cards}` : ans.reply, cards: undefined };
    await env.DB.prepare("UPDATE chats SET ai_draft = ? WHERE id = ?").bind(JSON.stringify(draft), chat.id).run();
    if (codeSent) return; // they're busy with the code; the next answer comes once it's entered
    if (!open) {
      await env.DB.prepare("INSERT INTO notes (ticket_id, agent_id, body) VALUES (?, NULL, ?)")
        .bind(chat.ticket_id, `AI suggested reply (chat came in after hours):\n\n${draft.reply}${ans.reason ? `\n\nWhy: ${ans.reason}` : ""}`)
        .run();
    } else if (chat.state !== "waiting") {
      await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: SAY_WAITING });
    }
    return toPerson(ans.handoff ? `AI suggests a person: ${ans.reason}` : "AI drafted a reply for a teammate to check");
  }

  // Auto: the AI answers the customer directly
  await addChatMessage(env, chat, { kind: "chat_ai", direction: "out", text: ans.reply, extra: ans.cards });
  await sendCode();
  await env.DB.prepare("UPDATE chats SET ai_replies = ai_replies + 1, ai_draft = NULL WHERE id = ?").bind(chat.id).run();
  if (ans.handoff) return toPerson(`AI handed off: ${ans.reason}`);
  const t = await getTicket(env, chat.ticket_id);
  if (t && t.status === "open") await setStatus(env, t, "in_progress", null, { source: "answered by AI" });
}

/** A teammate's chat reply. If the customer has left, it goes by email with the transcript. */
export async function agentChatReply(env: Env, chat: ChatRow, agent: { id: number; name: string }, text: string, files?: ChatFile[]) {
  if (!text.trim() && !files?.length) throw new HttpError(400, "Message is empty");
  const visitorHere = chat.visitor_seen_at && Date.now() - Date.parse(chat.visitor_seen_at) < 90_000;
  if (chat.state === "email" || !visitorHere) {
    await moveChatToEmail(env, chat, { reason: `${agent.name} replied after the customer left the chat`, lead: text, agentId: agent.id, fromName: env.APP_NAME });
    return { via: "email" as const };
  }
  await addChatMessage(env, chat, { kind: "chat", direction: "out", text, files, agentId: agent.id, fromName: agent.name });
  await env.DB.prepare("UPDATE chats SET ai_draft = NULL, agent_typing_at = NULL WHERE id = ?").bind(chat.id).run();
  await setChatState(env, chat, "agent");
  const t = await getTicket(env, chat.ticket_id);
  if (t) {
    await env.DB.prepare("UPDATE tickets SET unread = 0, first_response_at = COALESCE(first_response_at, ?), assignee_id = COALESCE(assignee_id, ?) WHERE id = ?")
      .bind(nowIso(), agent.id, t.id)
      .run();
    if (t.status !== "in_progress") await setStatus(env, t, "in_progress", agent.id, { source: "chat reply" });
  }
  return { via: "chat" as const };
}

/**
 * Every minute: chats waiting on a person too long move to email; chats whose visitor left wrap up
 * (answered by the AI → closed; waiting → email).
 */
export async function sweepChats(env: Env) {
  const s = await chatSettings(env);
  const { results } = await env.DB.prepare("SELECT * FROM chats WHERE state IN ('ai','waiting','agent') ORDER BY updated_at LIMIT 50").all<ChatRow>();
  const now = Date.now();
  for (const chat of results) {
    const seen = chat.visitor_seen_at ? Date.parse(chat.visitor_seen_at) : 0;
    const gone = now - seen > 2 * 60_000;
    try {
      if (chat.state === "waiting") {
        const waited = chat.waiting_since ? now - Date.parse(chat.waiting_since) : 0;
        if (gone || waited > s.handoffMinutes * 60_000) {
          await moveChatToEmail(env, chat, { reason: gone ? "The customer left before anyone replied" : `Nobody replied within ${s.handoffMinutes} min` });
        }
      } else if (now - seen > 30 * 60_000) {
        await setChatState(env, chat, "ended");
        await addChatMessage(env, chat, { kind: "chat_system", direction: "out", text: "Chat ended." });
        const last = await env.DB.prepare("SELECT kind, direction FROM messages WHERE ticket_id = ? AND kind IN ('chat','chat_ai') ORDER BY id DESC LIMIT 1")
          .bind(chat.ticket_id).first<{ kind: string; direction: string }>();
        const t = await getTicket(env, chat.ticket_id);
        if (t && last?.kind === "chat_ai" && t.status === "in_progress") {
          await setStatus(env, t, "closed", null, { source: "chat answered by AI" });
        } else if (t && last?.direction === "in") {
          // The customer's last word went unanswered: carry on by email
          await moveChatToEmail(env, chat, { reason: "The customer left with a question unanswered" });
        }
      }
    } catch (e) {
      console.error("chat sweep", chat.id, e);
    }
  }
}

