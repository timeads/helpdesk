// Instagram and Facebook through Meta's Graph API: comments on our posts and direct messages become
// tickets, and replies go back as a public reply, a private reply (a DM about that comment) or a DM.
// Meta sends new comments and messages to /meta/webhook; the connection (our Page, its Instagram account
// and the Page's access token) is made once from Settings with Facebook Login.
import type { Env } from "../env";
import { getTicket, logEvent, setStatus } from "./support";
import { HttpError, decrypt, encrypt, getSetting, nowIso, randomId, setSetting, deleteSetting } from "./util";

export type Platform = "instagram" | "facebook";
export type ThreadKind = "comment" | "dm";

export const graphVersion = (env: Env) => env.META_GRAPH_VERSION || "v23.0";
const GRAPH = (env: Env) => `https://graph.facebook.com/${graphVersion(env)}`;

export const metaConfigured = (env: Env) => !!(env.META_APP_ID && env.META_APP_SECRET);

/** What Facebook Login asks for: read and answer Page + Instagram comments and messages. */
export const META_SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_read_user_content", "pages_manage_metadata", "pages_manage_engagement", "pages_messaging",
  "instagram_basic", "instagram_manage_comments", "instagram_manage_messages", "business_management",
];

// ---------------------------------------------------------------- Settings & connection

export interface SocialSettings { igComments: boolean; igDms: boolean; fbComments: boolean; fbDms: boolean; skipNoise: boolean }
export const DEFAULT_SOCIAL: SocialSettings = { igComments: true, igDms: true, fbComments: true, fbDms: true, skipNoise: true };
export const socialSettings = async (env: Env): Promise<SocialSettings> => ({ ...DEFAULT_SOCIAL, ...(await getSetting<Partial<SocialSettings>>(env, "social_settings", {})) });
export async function saveSocialSettings(env: Env, next: Partial<SocialSettings>) {
  const cur = await socialSettings(env);
  const out = Object.fromEntries(Object.keys(DEFAULT_SOCIAL).map((k) => [k, typeof (next as any)[k] === "boolean" ? (next as any)[k] : (cur as any)[k]])) as unknown as SocialSettings;
  await setSetting(env, "social_settings", out);
  return out;
}

interface StoredConnection { pageId: string; pageName: string; token: string; igId: string | null; igUsername: string | null; connectedAt: string; subscribed: { page: boolean; app: string | null } }
export interface Connection extends Omit<StoredConnection, "token"> { token: string }

export async function metaConnection(env: Env): Promise<Connection | null> {
  const c = await getSetting<StoredConnection | null>(env, "meta_connection", null);
  if (!c) return null;
  try {
    return { ...c, token: await decrypt(env, c.token) };
  } catch {
    return null; // SESSION_SECRET changed: connect again
  }
}

/** The token Meta must echo back when it checks our webhook address (made once, shown in Settings). */
export async function verifyToken(env: Env) {
  let t = await getSetting<string>(env, "meta_verify_token", "");
  if (!t) {
    t = randomId(18);
    await setSetting(env, "meta_verify_token", t);
  }
  return t;
}

// ---------------------------------------------------------------- Graph API

export class MetaError extends HttpError {
  constructor(status: number, message: string, public code?: number, public subcode?: number) { super(status, message); }
}

/** Plain words for the Meta errors a teammate can do something about. */
function explain(code: number | undefined, subcode: number | undefined, message: string) {
  if (code === 190) return "Meta's access for the help desk expired or was removed — reconnect in Settings → Instagram & Facebook";
  if (code === 10 && subcode === 2018278) return "It's been more than 24 hours since their last message, so Meta won't deliver a DM. Reply publicly, or wait for them to write again";
  if (code === 10 || code === 200 || code === 230) return `Meta didn't allow that (${message}) — check the app's permissions in Meta for Developers`;
  if (code === 4 || code === 17 || code === 32 || code === 613) return "Meta is limiting how fast we can send — try again in a few minutes";
  if (code === 100 && /private repl|already/i.test(message)) return "That comment already got its one private reply — carry on in the DM";
  return `Meta: ${message}`;
}

export async function graph<T = any>(env: Env, path: string, opts: { token: string; method?: "GET" | "POST" | "DELETE"; params?: Record<string, string>; json?: unknown }): Promise<T> {
  const url = new URL(`${GRAPH(env)}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  url.searchParams.set("access_token", opts.token);
  const r = await fetch(url, {
    method: opts.method ?? "GET",
    headers: opts.json ? { "content-type": "application/json" } : undefined,
    body: opts.json ? JSON.stringify(opts.json) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || data?.error) {
    const e = data?.error ?? {};
    throw new MetaError(r.status >= 400 && r.status < 500 ? 409 : 502, explain(e.code, e.error_subcode, String(e.message ?? `HTTP ${r.status}`)), e.code, e.error_subcode);
  }
  return data as T;
}

// ---------------------------------------------------------------- Connecting (Facebook Login)

export function loginUrl(env: Env, redirectUri: string, state: string) {
  const u = new URL(`https://www.facebook.com/${graphVersion(env)}/dialog/oauth`);
  u.searchParams.set("client_id", env.META_APP_ID!);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", META_SCOPES.join(","));
  return u.toString();
}

export interface PageChoice { id: string; name: string; token: string; igId: string | null; igUsername: string | null }

/** Code from Facebook Login → long-lived user token → the Pages this person manages (with long-lived Page tokens). */
export async function pagesFromCode(env: Env, code: string, redirectUri: string): Promise<PageChoice[]> {
  const app = { client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET! };
  const short = await fetch(`${GRAPH(env)}/oauth/access_token?${new URLSearchParams({ ...app, redirect_uri: redirectUri, code })}`).then((r) => r.json()) as any;
  if (!short.access_token) throw new HttpError(400, `Facebook didn't sign you in: ${short.error?.message ?? "no token"}`);
  const long = await fetch(`${GRAPH(env)}/oauth/access_token?${new URLSearchParams({ ...app, grant_type: "fb_exchange_token", fb_exchange_token: short.access_token })}`).then((r) => r.json()) as any;
  const userToken = long.access_token ?? short.access_token;
  const pages = await graph<{ data: any[] }>(env, "me/accounts", { token: userToken, params: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" } });
  return (pages.data ?? []).map((p) => ({ id: p.id, name: p.name, token: p.access_token, igId: p.instagram_business_account?.id ?? null, igUsername: p.instagram_business_account?.username ?? null }));
}

/** Saves the Page, then asks Meta to send its comments and messages (and the Instagram account's) to our webhook. */
export async function connectPage(env: Env, page: PageChoice, origin: string) {
  const subscribed = { page: false, app: null as string | null };
  try {
    await graph(env, `${page.id}/subscribed_apps`, { token: page.token, method: "POST", params: { subscribed_fields: "feed,messages,message_echoes" } });
    subscribed.page = true;
  } catch (e) {
    console.error("Page subscription failed", e);
  }
  // App-level webhook subscriptions (so nobody has to fill in the Webhooks screen by hand)
  try {
    const appToken = `${env.META_APP_ID}|${env.META_APP_SECRET}`;
    const callback = `${origin}/meta/webhook`;
    const verify = await verifyToken(env);
    await graph(env, `${env.META_APP_ID}/subscriptions`, { token: appToken, method: "POST", params: { object: "page", callback_url: callback, verify_token: verify, fields: "feed,messages,message_echoes" } });
    if (page.igId) await graph(env, `${env.META_APP_ID}/subscriptions`, { token: appToken, method: "POST", params: { object: "instagram", callback_url: callback, verify_token: verify, fields: "comments,messages" } });
  } catch (e) {
    subscribed.app = (e as Error).message;
  }
  const stored: StoredConnection = {
    pageId: page.id, pageName: page.name, token: await encrypt(env, page.token), igId: page.igId, igUsername: page.igUsername, connectedAt: nowIso(), subscribed,
  };
  await setSetting(env, "meta_connection", stored);
  await deleteSetting(env, "meta_pending_pages");
  return stored;
}

export async function disconnectMeta(env: Env) {
  const c = await metaConnection(env);
  if (c) await graph(env, `${c.pageId}/subscribed_apps`, { token: c.token, method: "DELETE" }).catch(() => {});
  await deleteSetting(env, "meta_connection");
}

/** Pages to choose from when the person manages several (kept encrypted for a few minutes). */
export async function savePendingPages(env: Env, pages: PageChoice[]) {
  await setSetting(env, "meta_pending_pages", { at: nowIso(), sealed: await encrypt(env, JSON.stringify(pages)) });
}
export async function pendingPages(env: Env): Promise<PageChoice[]> {
  const p = await getSetting<{ at: string; sealed: string } | null>(env, "meta_pending_pages", null);
  if (!p || Date.now() - Date.parse(p.at) > 30 * 60_000) return [];
  try { return JSON.parse(await decrypt(env, p.sealed)); } catch { return []; }
}

// ---------------------------------------------------------------- Webhook

/** Meta signs each delivery with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export async function validSignature(env: Env, raw: string, header: string | null | undefined) {
  if (!env.META_APP_SECRET || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Emoji-only, tag-only ("@friend 😍") and one-word reactions aren't worth a ticket. */
export function isNoise(text: string) {
  const words = text.replace(/@[\w.]+/g, " ").replace(/https?:\/\/\S+/g, " ");
  const letters = words.match(/[\p{L}\p{N}]/gu) ?? [];
  if (letters.length < 3) return true;
  // Tagging a friend with a word or two ("@amy look!", "@sam we need this") — unless it's a question
  if (/@[\w.]/.test(text) && !text.includes("?") && words.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length <= 4) return true;
  return /^\s*(love( it| this)?|wow|nice|cool|amazing|beautiful|gorgeous|so cute|cute|yes+|omg|obsessed|need( this)?|want( this)?|goals|stunning|fire|great( job| work)?)[\s!.❤️♥️🔥😍🙌👏✨]*$/iu.test(words.trim());
}

export interface Incoming {
  platform: Platform;
  kind: ThreadKind;
  userId: string;
  userName: string | null;
  text: string;
  externalId: string;
  at: string;
  postId?: string | null;
  commentId?: string | null;
  parentId?: string | null;
  files?: { type: string; url: string }[];
}

type Handled = { ticketId: number | null; skipped?: string };

/** Turns one webhook delivery into tickets and messages. */
export async function handleWebhook(env: Env, payload: any): Promise<Handled[]> {
  const conn = await metaConnection(env);
  if (!conn) return [];
  const out: Handled[] = [];
  const platform: Platform | null = payload?.object === "instagram" ? "instagram" : payload?.object === "page" ? "facebook" : null;
  if (!platform) return out;
  const ours = new Set([conn.pageId, conn.igId].filter(Boolean) as string[]);
  for (const entry of payload.entry ?? []) {
    // Comments
    for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      if (platform === "facebook" && ch.field === "feed" && v.item === "comment" && v.verb === "add") {
        const own = ours.has(String(v.from?.id ?? ""));
        out.push(await (own ? ourComment(env, String(v.comment_id), String(v.parent_id ?? ""), String(v.message ?? ""), platform) : ingest(env, conn, {
          platform, kind: "comment", userId: String(v.from?.id ?? ""), userName: v.from?.name ?? null, text: String(v.message ?? ""),
          externalId: String(v.comment_id), at: v.created_time ? new Date(Number(v.created_time) * 1000).toISOString() : nowIso(),
          postId: String(v.post_id ?? ""), commentId: String(v.comment_id), parentId: v.parent_id ? String(v.parent_id) : null,
          files: v.photo ? [{ type: "image", url: String(v.photo) }] : undefined,
        })));
      }
      if (platform === "instagram" && ch.field === "comments" && v.id) {
        const own = ours.has(String(v.from?.id ?? "")) || (!!conn.igUsername && v.from?.username === conn.igUsername);
        out.push(await (own ? ourComment(env, String(v.id), String(v.parent_id ?? ""), String(v.text ?? ""), platform) : ingest(env, conn, {
          platform, kind: "comment", userId: String(v.from?.id ?? v.from?.username ?? ""), userName: v.from?.username ?? null, text: String(v.text ?? ""),
          externalId: String(v.id), at: nowIso(), postId: String(v.media?.id ?? ""), commentId: String(v.id), parentId: v.parent_id ? String(v.parent_id) : null,
        })));
      }
    }
    // Direct messages (Messenger and Instagram use the same shape)
    for (const m of entry.messaging ?? []) {
      const msg = m.message;
      if (!msg?.mid) continue;
      if (msg.is_echo) {
        out.push(await echo(env, platform, String(m.recipient?.id ?? ""), msg));
        continue;
      }
      if (ours.has(String(m.sender?.id ?? ""))) continue;
      const files = (msg.attachments ?? []).filter((a: any) => a.payload?.url).map((a: any) => ({ type: String(a.type), url: String(a.payload.url) }));
      out.push(await ingest(env, conn, {
        platform, kind: "dm", userId: String(m.sender?.id ?? ""), userName: null, text: String(msg.text ?? ""), externalId: String(msg.mid),
        at: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : nowIso(), files,
      }));
    }
  }
  if (out.length) await setSetting(env, "meta_last_event", nowIso());
  return out;
}

const threadKey = (i: Pick<Incoming, "platform" | "kind" | "userId" | "postId">) =>
  i.kind === "dm" ? `${i.platform}:dm:${i.userId}` : `${i.platform}:c:${i.postId}:${i.userId}`;

export interface ThreadRow {
  id: number; ticket_id: number; platform: Platform; kind: ThreadKind; thread_key: string; user_id: string; user_name: string | null;
  post_id: string | null; post_caption: string | null; post_url: string | null; post_image: string | null; last_comment_id: string | null; last_inbound_at: string | null;
}

const LABEL: Record<Platform, string> = { instagram: "Instagram", facebook: "Facebook" };

/** A customer's comment or DM: onto their ticket (reopened if it was closed), or a new ticket. */
export async function ingest(env: Env, conn: Connection, i: Incoming): Promise<Handled> {
  if (!i.userId || !i.externalId) return { ticketId: null, skipped: "incomplete" };
  const s = await socialSettings(env);
  const on = i.platform === "instagram" ? (i.kind === "dm" ? s.igDms : s.igComments) : (i.kind === "dm" ? s.fbDms : s.fbComments);
  if (!on) return { ticketId: null, skipped: "off" };
  if (await env.DB.prepare("SELECT 1 FROM messages WHERE external_id = ?").bind(i.externalId).first()) return { ticketId: null, skipped: "duplicate" };
  const key = threadKey(i);
  let thread = await env.DB.prepare("SELECT * FROM social_threads WHERE thread_key = ?").bind(key).first<ThreadRow>();
  // A comment that's only emoji or tags starts nothing; on a conversation already going, it's kept
  if (!thread && i.kind === "comment" && s.skipNoise && !i.files?.length && isNoise(i.text)) return { ticketId: null, skipped: "noise" };
  let ticket = thread ? await getTicket(env, thread.ticket_id) : null;
  if (ticket && ["deleted", "spam"].includes(ticket.status)) {
    await env.DB.prepare("DELETE FROM social_threads WHERE id = ?").bind(thread!.id).run();
    thread = null;
    ticket = null;
  }
  if (!thread) {
    const name = i.userName ?? (i.kind === "dm" ? await profileName(env, conn, i.platform, i.userId) : null);
    const handle = i.platform === "instagram" && name && !name.includes(" ") ? name : null;
    const first = i.text.trim().split("\n").find((l) => l.trim())?.trim() || (i.files?.length ? "Sent a photo" : "New message");
    const subject = `${LABEL[i.platform]} ${i.kind === "dm" ? "message" : "comment"}: ${first.length > 70 ? `${first.slice(0, 67)}…` : first}`;
    const customer = `${i.platform}:${handle ?? i.userId}`;
    const at = i.at;
    const t = await env.DB.prepare(
      `INSERT INTO tickets (subject, customer_email, customer_name, status, unread, snippet, created_at, last_message_at, last_inbound_at, channel, tags)
       VALUES (?, ?, ?, 'open', 1, '', ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(subject, customer, handle ? `@${handle}` : name ?? `${LABEL[i.platform]} user`, at, at, at, i.platform, JSON.stringify([LABEL[i.platform]])).first<{ id: number }>();
    const post = i.kind === "comment" && i.postId ? await postInfo(env, conn, i.platform, i.postId) : null;
    await env.DB.prepare(
      `INSERT INTO social_threads (ticket_id, platform, kind, thread_key, user_id, user_name, post_id, post_caption, post_url, post_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(t!.id, i.platform, i.kind, key, i.userId, name, i.postId ?? null, post?.caption ?? null, post?.url ?? null, post?.image ?? null).run();
    thread = (await env.DB.prepare("SELECT * FROM social_threads WHERE thread_key = ?").bind(key).first<ThreadRow>())!;
    await logEvent(env, t!.id, "received", `${LABEL[i.platform]} ${i.kind === "dm" ? "direct message" : "comment"}`);
  } else if (ticket && !["open", "in_progress"].includes(ticket.status)) {
    await setStatus(env, ticket, "open", null, { source: `new ${LABEL[i.platform]} ${i.kind === "dm" ? "message" : "comment"}` });
  }
  await addSocialMessage(env, thread, { direction: "in", text: i.text, externalId: i.externalId, at: i.at, files: i.files, extra: i.commentId ? { commentId: i.commentId } : null });
  await env.DB.prepare(`UPDATE social_threads SET updated_at = ?, ${i.kind === "dm" ? "last_inbound_at = ?" : "last_comment_id = ?"} WHERE id = ?`)
    .bind(nowIso(), i.kind === "dm" ? i.at : i.commentId, thread.id).run();
  return { ticketId: thread.ticket_id };
}

/** Our own reply under a customer's comment (made here or in the Instagram/Facebook app): added to their ticket. */
async function ourComment(env: Env, commentId: string, parentId: string, text: string, platform: Platform): Promise<Handled> {
  if (!parentId || await env.DB.prepare("SELECT 1 FROM messages WHERE external_id = ?").bind(commentId).first()) return { ticketId: null, skipped: "ours" };
  const parent = await env.DB.prepare("SELECT ticket_id FROM messages WHERE external_id = ?").bind(parentId).first<{ ticket_id: number }>();
  const thread = parent ? await env.DB.prepare("SELECT * FROM social_threads WHERE ticket_id = ? AND kind = 'comment' ORDER BY id LIMIT 1").bind(parent.ticket_id).first<ThreadRow>() : null;
  if (!thread) return { ticketId: null, skipped: "ours" };
  await addSocialMessage(env, thread, { direction: "out", text, externalId: commentId, at: nowIso(), fromName: `${LABEL[platform]} app`, extra: { via: "public" } });
  return { ticketId: thread.ticket_id };
}

/** A DM we sent: from here it's already on the ticket; from the Instagram/Messenger app it's added. */
async function echo(env: Env, platform: Platform, userId: string, msg: any): Promise<Handled> {
  if (await env.DB.prepare("SELECT 1 FROM messages WHERE external_id = ?").bind(String(msg.mid)).first()) return { ticketId: null, skipped: "ours" };
  const thread = await env.DB.prepare("SELECT * FROM social_threads WHERE thread_key = ?").bind(`${platform}:dm:${userId}`).first<ThreadRow>();
  if (!thread || !msg.text) return { ticketId: null, skipped: "ours" };
  await addSocialMessage(env, thread, { direction: "out", text: String(msg.text), externalId: String(msg.mid), at: nowIso(), fromName: platform === "instagram" ? "Instagram app" : "Messenger", extra: { via: "dm" } });
  return { ticketId: thread.ticket_id };
}

async function profileName(env: Env, conn: Connection, platform: Platform, userId: string) {
  try {
    if (platform === "instagram") {
      const p = await graph<{ username?: string; name?: string }>(env, userId, { token: conn.token, params: { fields: "username,name" } });
      return p.username ?? p.name ?? null;
    }
    const p = await graph<{ first_name?: string; last_name?: string; name?: string }>(env, userId, { token: conn.token, params: { fields: "first_name,last_name" } });
    return [p.first_name, p.last_name].filter(Boolean).join(" ") || p.name || null;
  } catch {
    return null;
  }
}

async function postInfo(env: Env, conn: Connection, platform: Platform, postId: string) {
  try {
    if (platform === "instagram") {
      const p = await graph<any>(env, postId, { token: conn.token, params: { fields: "caption,permalink,media_url,thumbnail_url,media_type" } });
      return { caption: (p.caption ?? "").slice(0, 500), url: p.permalink ?? null, image: p.media_type === "VIDEO" ? p.thumbnail_url ?? null : p.media_url ?? null };
    }
    const p = await graph<any>(env, postId, { token: conn.token, params: { fields: "message,permalink_url,full_picture" } });
    return { caption: (p.message ?? "").slice(0, 500), url: p.permalink_url ?? null, image: p.full_picture ?? null };
  } catch {
    return null;
  }
}

/** Downloads a photo they sent (Meta's links expire); other attachments are linked in the text. */
async function keepFiles(env: Env, files: { type: string; url: string }[] | undefined) {
  const kept: { id: string; filename: string; mimeType: string }[] = [];
  const links: string[] = [];
  for (const f of (files ?? []).slice(0, 4)) {
    if (f.type !== "image") { links.push(`[${f.type}] ${f.url}`); continue; }
    try {
      const r = await fetch(f.url);
      const mime = r.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
      const buf = new Uint8Array(await r.arrayBuffer());
      if (!r.ok || !mime.startsWith("image/") || buf.length > 6 * 1024 * 1024) { links.push(`[photo] ${f.url}`); continue; }
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const row = await env.DB.prepare("INSERT INTO social_files (mime, filename, data) VALUES (?, ?, ?) RETURNING id").bind(mime, `photo.${mime.split("/")[1] || "jpg"}`, btoa(bin)).first<{ id: number }>();
      kept.push({ id: `s${row!.id}`, filename: `photo.${mime.split("/")[1] || "jpg"}`, mimeType: mime });
    } catch {
      links.push(`[photo] ${f.url}`);
    }
  }
  return { kept, links };
}

export async function addSocialMessage(
  env: Env,
  thread: ThreadRow,
  m: { direction: "in" | "out"; text: string; externalId: string | null; at: string; files?: { type: string; url: string }[]; agentId?: number | null; fromName?: string | null; extra?: Record<string, unknown> | null },
) {
  const { kept, links } = await keepFiles(env, m.files);
  const text = [m.text.trim(), ...links].filter(Boolean).join("\n").slice(0, 8000);
  const t = await getTicket(env, thread.ticket_id);
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (ticket_id, direction, from_email, from_name, to_emails, subject, sent_at, body_text, body_html, attachments, agent_id, kind, extra, external_id)
     VALUES (?, ?, ?, ?, '', NULL, ?, ?, NULL, ?, ?, 'social', ?, ?) RETURNING id`,
  ).bind(thread.ticket_id, m.direction, m.direction === "in" ? t?.customer_email ?? thread.user_id : `us@${thread.platform}`,
    m.fromName ?? (m.direction === "in" ? thread.user_name : null), m.at, text, JSON.stringify(kept), m.agentId ?? null,
    m.extra ? JSON.stringify(m.extra) : null, m.externalId).first<{ id: number }>();
  if (!r) return null;
  const snippet = (text || (kept.length ? "📷 Photo" : "")).slice(0, 200);
  await env.DB.prepare(
    `UPDATE tickets SET message_count = message_count + 1, last_message_at = ?1, snippet = ?2
       ${m.direction === "in" ? ", last_inbound_at = ?1, unread = 1" : ""} WHERE id = ?3`,
  ).bind(m.at, snippet, thread.ticket_id).run();
  return r.id;
}

// ---------------------------------------------------------------- Replying

export type Via = "public" | "private" | "dm";

export async function ticketThreads(env: Env, ticketId: number) {
  const { results } = await env.DB.prepare("SELECT * FROM social_threads WHERE ticket_id = ? ORDER BY id").bind(ticketId).all<ThreadRow>();
  return results;
}

/** What the reply box offers: a public reply and a private one for comments, a DM while Meta's 24-hour window is open. */
export function replyOptions(threads: ThreadRow[], privateUsed: Set<string>, now = Date.now()) {
  const comment = threads.find((t) => t.kind === "comment" && t.last_comment_id);
  const dm = threads.find((t) => t.kind === "dm");
  const dmOpen = !!dm?.last_inbound_at && now - Date.parse(dm.last_inbound_at) < 24 * 3600_000;
  return {
    public: !!comment,
    private: !!comment && !dm && !privateUsed.has(comment.last_comment_id!),
    dm: !!dm,
    dmOpen,
    dmClosesAt: dm?.last_inbound_at ? new Date(Date.parse(dm.last_inbound_at) + 24 * 3600_000).toISOString() : null,
  };
}

export async function privateRepliesUsed(env: Env, ticketId: number) {
  const { results } = await env.DB.prepare("SELECT extra FROM messages WHERE ticket_id = ? AND kind = 'social' AND direction = 'out' AND extra LIKE '%\"private\"%'").bind(ticketId).all<{ extra: string }>();
  return new Set(results.map((r) => { try { return String(JSON.parse(r.extra).commentId ?? ""); } catch { return ""; } }).filter(Boolean));
}

/** Sends a teammate's reply: under their comment, privately about it, or as a DM. */
export async function sendSocialReply(env: Env, ticketId: number, agent: { id: number; name: string }, text: string, via: Via) {
  const body = text.trim();
  if (!body) throw new HttpError(400, "Message is empty");
  const conn = await metaConnection(env);
  if (!conn) throw new HttpError(409, "Instagram & Facebook aren't connected — connect them in Settings");
  const threads = await ticketThreads(env, ticketId);
  const comment = threads.find((t) => t.kind === "comment" && t.last_comment_id);
  let dm = threads.find((t) => t.kind === "dm");
  let externalId: string | null = null;
  let thread: ThreadRow;
  let extra: Record<string, unknown> = { via };
  if (via === "public") {
    if (!comment) throw new HttpError(400, "There's no comment to reply under");
    const r = await graph<{ id: string }>(env, `${comment.last_comment_id}/${comment.platform === "instagram" ? "replies" : "comments"}`, { token: conn.token, method: "POST", params: { message: body.slice(0, 2200) } });
    externalId = r.id;
    thread = comment;
    extra = { via, commentId: comment.last_comment_id };
  } else if (via === "private") {
    if (!comment) throw new HttpError(400, "There's no comment to reply to");
    const r = await graph<{ recipient_id?: string; message_id?: string }>(env, "me/messages", { token: conn.token, method: "POST", json: { recipient: { comment_id: comment.last_comment_id }, message: { text: body.slice(0, 1000) } } });
    externalId = r.message_id ?? null;
    extra = { via, commentId: comment.last_comment_id };
    // Their answer arrives as a DM: keep it on this ticket
    if (r.recipient_id && !dm) {
      await env.DB.prepare("INSERT OR IGNORE INTO social_threads (ticket_id, platform, kind, thread_key, user_id, user_name) VALUES (?, ?, 'dm', ?, ?, ?)")
        .bind(ticketId, comment.platform, `${comment.platform}:dm:${r.recipient_id}`, r.recipient_id, comment.user_name).run();
    }
    thread = comment;
  } else {
    if (!dm) throw new HttpError(400, "There's no direct message conversation on this ticket");
    const r = await graph<{ message_id?: string }>(env, "me/messages", { token: conn.token, method: "POST", json: { recipient: { id: dm.user_id }, messaging_type: "RESPONSE", message: { text: body.slice(0, 1000) } } });
    externalId = r.message_id ?? null;
    thread = dm;
  }
  await addSocialMessage(env, thread, { direction: "out", text: body, externalId, at: nowIso(), agentId: agent.id, fromName: agent.name, extra });
  const t = await getTicket(env, ticketId);
  if (t) {
    await env.DB.prepare("UPDATE tickets SET unread = 0, first_response_at = COALESCE(first_response_at, ?), assignee_id = COALESCE(assignee_id, ?) WHERE id = ?").bind(nowIso(), agent.id, t.id).run();
    if (t.status !== "in_progress") await setStatus(env, t, "in_progress", agent.id, { source: `${LABEL[thread.platform]} reply` });
  }
  return { ok: true, via };
}
