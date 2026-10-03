// The website chat widget's API (no login). Each chat is reached with its id + secret token, and
// only from the sites listed in Settings → Chat.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
  addChatMessage, authedChat, checkVerifyCode, chatMessages, chatSettings, hashIp, hoursText, isOpen, moveChatToEmail, respond, startChat, type ChatFile,
} from "../lib/chat";
import { aiConfigured } from "../lib/ai";
import { HttpError, nowIso } from "../lib/util";

const chatApi = new Hono<AppEnv>();

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/;

// CORS: only the store's own sites (and this app, for the preview in Settings)
chatApi.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const s = await chatSettings(c.env);
  const self = new URL(c.req.url).origin;
  const allowed = !origin || origin === self || s.origins.includes(origin);
  if (c.req.method === "OPTIONS") {
    if (!allowed) return c.body(null, 403);
    return c.body(null, 204, {
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-chat-token",
      "access-control-max-age": "86400",
      vary: "Origin",
    });
  }
  if (!allowed) throw new HttpError(403, "This site can't use the chat");
  await next();
  if (origin) {
    c.res.headers.set("access-control-allow-origin", origin);
    c.res.headers.set("vary", "Origin");
  }
  c.res.headers.set("cache-control", "no-store");
});

const ipHash = (c: { req: { header(n: string): string | undefined } }) => hashIp(c.req.header("cf-connecting-ip") ?? "local");

function cleanFiles(raw: unknown): ChatFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 4).map((f: any) => ({ filename: String(f?.name ?? "photo.jpg"), mime: String(f?.mime ?? ""), data: String(f?.data ?? "") }));
}

/** What the widget needs to draw itself. */
chatApi.get("/config", async (c) => {
  const s = await chatSettings(c.env);
  return c.json({
    enabled: s.enabled,
    title: s.title,
    greeting: s.greeting,
    offlineMessage: s.offlineMessage,
    color: s.color,
    position: s.position,
    open: isOpen(s),
    hours: hoursText(s),
    ai: s.aiMode === "auto" && aiConfigured(c.env),
    photos: s.allowPhotos,
  });
});

chatApi.post("/start", async (c) => {
  const s = await chatSettings(c.env);
  // While it's off, only the preview page on this app can start chats
  const self = new URL(c.req.url).origin;
  if (!s.enabled && c.req.header("origin") !== self) throw new HttpError(403, "Chat is turned off");
  const body = await c.req.json<{ name?: string; email?: string; message?: string; page?: string; website?: string; files?: unknown }>();
  if (body.website) throw new HttpError(400, "Couldn't start the chat"); // honeypot field bots fill in
  const email = String(body.email ?? "").trim().toLowerCase();
  const message = String(body.message ?? "").trim();
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email so we can follow up");
  if (!message) throw new HttpError(400, "Type a message to start");
  const ip = await ipHash(c);
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chats WHERE ip_hash = ? AND created_at > ?")
    .bind(ip, new Date(Date.now() - 3600_000).toISOString()).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 6) throw new HttpError(429, "Too many chats from here — please email us instead");
  const chat = await startChat(c.env, {
    name: String(body.name ?? "").trim().slice(0, 80),
    email: email.slice(0, 200),
    message: message.slice(0, 4000),
    page: body.page ? String(body.page).slice(0, 300) : null,
    ipHash: ip,
    files: s.allowPhotos ? cleanFiles(body.files) : undefined,
  });
  c.executionCtx.waitUntil(respond(c.env, chat.id).catch((e) => console.error("chat respond", e)));
  return c.json({ id: chat.id, token: chat.token });
});

/** New messages since `after`, plus who's here. Also marks the visitor as present. */
chatApi.get("/:id", async (c) => {
  const chat = await authedChat(c.env, c.req.param("id"), c.req.header("x-chat-token"));
  const now = Date.now();
  if (!chat.visitor_seen_at || now - Date.parse(chat.visitor_seen_at) > 15_000) {
    await c.env.DB.prepare("UPDATE chats SET visitor_seen_at = ? WHERE id = ?").bind(nowIso(), chat.id).run();
  }
  const s = await chatSettings(c.env);
  return c.json({
    state: chat.state,
    messages: await chatMessages(c.env, chat, Number(c.req.query("after")) || 0),
    agentTyping: !!chat.agent_typing_at && now - Date.parse(chat.agent_typing_at) < 8000,
    thinking: chat.state === "ai" && s.aiMode === "auto",
    email: chat.email,
  });
});

chatApi.post("/:id/messages", async (c) => {
  const chat = await authedChat(c.env, c.req.param("id"), c.req.header("x-chat-token"));
  if (chat.state === "email" || chat.state === "ended") throw new HttpError(409, "This chat has ended — start a new one");
  const s = await chatSettings(c.env);
  const body = await c.req.json<{ text?: string; files?: unknown }>();
  const text = String(body.text ?? "").trim();
  const files = s.allowPhotos ? cleanFiles(body.files) : undefined;
  if (!text && !files?.length) throw new HttpError(400, "Message is empty");
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ? AND kind = 'chat' AND direction = 'in'").bind(chat.ticket_id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 80) throw new HttpError(429, "This chat is very long — we'll follow up by email");
  if (files?.length) {
    const f = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE chat_id = ?").bind(chat.id).first<{ n: number }>();
    if ((f?.n ?? 0) + files.length > 12) throw new HttpError(429, "That's the most photos one chat can take — send more by email");
  }
  // The one-time code for looking up orders: kept out of the transcript, checked here
  const code = !files?.length ? await checkVerifyCode(c.env, chat, text) : null;
  const id = await addChatMessage(c.env, chat, { kind: "chat", direction: "in", text: code ? "••••••" : text.slice(0, 4000), files });
  await c.env.DB.prepare("UPDATE chats SET visitor_seen_at = ?, visitor_typing_at = NULL WHERE id = ?").bind(nowIso(), chat.id).run();
  if (code === "bad" || code === "locked") {
    await addChatMessage(c.env, chat, {
      kind: "chat_system",
      direction: "out",
      text: code === "bad" ? "That code didn't match — check the latest email from us and try again." : "That code has expired or had too many tries. Ask for a new one and we'll send it.",
    });
    return c.json({ id });
  }
  if (code === "ok") await addChatMessage(c.env, chat, { kind: "chat_system", direction: "out", text: "Thanks — you're verified. Looking up your orders…" });
  c.executionCtx.waitUntil(respond(c.env, chat.id).catch((e) => console.error("chat respond", e)));
  return c.json({ id });
});

chatApi.post("/:id/typing", async (c) => {
  const chat = await authedChat(c.env, c.req.param("id"), c.req.header("x-chat-token"));
  await c.env.DB.prepare("UPDATE chats SET visitor_typing_at = ?, visitor_seen_at = ? WHERE id = ?").bind(nowIso(), nowIso(), chat.id).run();
  return c.json({ ok: true });
});

/** "Email me instead": the transcript goes to their inbox and the conversation carries on there. */
chatApi.post("/:id/email", async (c) => {
  const chat = await authedChat(c.env, c.req.param("id"), c.req.header("x-chat-token"));
  await moveChatToEmail(c.env, chat, { reason: "The customer asked to continue by email" });
  return c.json({ ok: true });
});

/** A photo in the chat (the widget can't send headers on <img>, so the token comes in the query). */
chatApi.get("/:id/files/:fid{c[0-9]+}", async (c) => {
  const chat = await authedChat(c.env, c.req.param("id"), c.req.query("t"));
  const f = await c.env.DB.prepare("SELECT mime, data FROM chat_files WHERE id = ? AND chat_id = ?")
    .bind(Number(c.req.param("fid").slice(1)), chat.id).first<{ mime: string; data: string }>();
  if (!f) throw new HttpError(404, "Not found");
  const bin = atob(f.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { "content-type": f.mime, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
});

export default chatApi;
