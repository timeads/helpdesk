// The team's side of website chats: live view of a chat on its ticket, replying, the AI's draft,
// moving a chat to email, and the Chat settings page.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import {
  agentChatReply, aiAnswerFor, chatForTicket, chatMessages, chatSettings, cleanChatSettings, hoursText, identitySecret, isOpen, moveChatToEmail, rotateIdentitySecret, type ChatFile, type ChatRow,
} from "../lib/chat";
import { HttpError, nowIso, setSetting } from "../lib/util";

const chats = new Hono<AppEnv>();

const recent = (iso: string | null, ms: number) => !!iso && Date.now() - Date.parse(iso) < ms;

async function ticketChat(env: AppEnv["Bindings"], ticketId: string) {
  const chat = await chatForTicket(env, Number(ticketId));
  if (!chat) throw new HttpError(404, "This ticket isn't a chat");
  return chat;
}

const describe = (chat: ChatRow) => ({
  state: chat.state,
  email: chat.email,
  name: chat.name,
  page: chat.page_url,
  visitorOnline: recent(chat.visitor_seen_at, 45_000) && !["email", "ended"].includes(chat.state),
  visitorTyping: recent(chat.visitor_typing_at, 8000),
  waitingSince: chat.waiting_since,
  aiReplies: chat.ai_replies,
  draft: chat.ai_draft ? JSON.parse(chat.ai_draft) : null,
});

chats.get("/settings", async (c) => {
  const s = await chatSettings(c.env);
  return c.json({ settings: s, open: isOpen(s), hours: hoursText(s), origin: new URL(c.req.url).origin });
});

/** Logged-in customers: whether the theme secret exists, and (admins) the secret itself to paste into the theme. */
chats.get("/identity", async (c) => {
  requireAdmin(c);
  const s = await identitySecret(c.env);
  return c.json({ secret: s?.secret ?? null, createdAt: s?.createdAt ?? null });
});

chats.post("/identity/rotate", async (c) => {
  requireAdmin(c);
  return c.json(await rotateIdentitySecret(c.env));
});

chats.put("/settings", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<{ settings?: unknown }>();
  const s = cleanChatSettings(body.settings, await chatSettings(c.env));
  await setSetting(c.env, "chat", s);
  return c.json({ settings: s, open: isOpen(s), hours: hoursText(s) });
});

/** Chats going on right now (for the sidebar). */
chats.get("/live", async (c) => {
  const since = new Date(Date.now() - 45_000).toISOString();
  const { results } = await c.env.DB.prepare(
    `SELECT c.ticket_id, c.name, c.email, c.state, c.waiting_since, c.visitor_seen_at, t.snippet, t.subject
     FROM chats c JOIN tickets t ON t.id = c.ticket_id
     WHERE c.state IN ('ai','waiting','agent') AND c.visitor_seen_at > ? ORDER BY c.state = 'waiting' DESC, c.updated_at DESC LIMIT 30`,
  ).bind(since).all<any>();
  return c.json({ chats: results });
});

/** The chat on a ticket, and its messages after `after`. Marks a teammate as watching. */
chats.get("/ticket/:tid{[0-9]+}", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  if (!recent(chat.agent_seen_at, 15_000)) await c.env.DB.prepare("UPDATE chats SET agent_seen_at = ? WHERE id = ?").bind(nowIso(), chat.id).run();
  return c.json({ chat: describe(chat), messages: await chatMessages(c.env, chat, Number(c.req.query("after")) || 0) });
});

chats.post("/ticket/:tid{[0-9]+}/send", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  const body = await c.req.json<{ text?: string; files?: { name?: string; mime?: string; data?: string }[] }>();
  const files: ChatFile[] | undefined = Array.isArray(body.files)
    ? body.files.slice(0, 4).map((f) => ({ filename: String(f.name ?? "photo.jpg"), mime: String(f.mime ?? ""), data: String(f.data ?? "") }))
    : undefined;
  const me = c.get("agent");
  const r = await agentChatReply(c.env, chat, { id: me.id, name: me.name }, String(body.text ?? ""), files);
  return c.json({ ...r, chat: describe((await chatForTicket(c.env, chat.ticket_id))!) });
});

chats.post("/ticket/:tid{[0-9]+}/typing", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  await c.env.DB.prepare("UPDATE chats SET agent_typing_at = ?, agent_seen_at = ? WHERE id = ?").bind(nowIso(), nowIso(), chat.id).run();
  return c.json({ ok: true });
});

/** A fresh AI suggestion for the next reply (kept as the chat's draft). */
chats.post("/ticket/:tid{[0-9]+}/suggest", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  const draft = await aiAnswerFor(c.env, chat, await chatSettings(c.env));
  await c.env.DB.prepare("UPDATE chats SET ai_draft = ? WHERE id = ?").bind(JSON.stringify(draft), chat.id).run();
  return c.json({ draft });
});

chats.post("/ticket/:tid{[0-9]+}/discard-draft", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  await c.env.DB.prepare("UPDATE chats SET ai_draft = NULL WHERE id = ?").bind(chat.id).run();
  return c.json({ ok: true });
});

chats.post("/ticket/:tid{[0-9]+}/email", async (c) => {
  const chat = await ticketChat(c.env, c.req.param("tid"));
  const me = c.get("agent");
  await moveChatToEmail(c.env, chat, { reason: `${me.name} moved the chat to email`, agentId: me.id });
  return c.json({ chat: describe((await chatForTicket(c.env, chat.ticket_id))!) });
});

export default chats;
