// Instagram & Facebook: connecting the Page (Facebook Login), what comes in, and replying from a ticket.
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import {
  connectPage, disconnectMeta, graphVersion, loginUrl, metaConfigured, metaConnection, pagesFromCode, pendingPages, privateRepliesUsed,
  replyOptions, saveSocialSettings, savePendingPages, sendSocialReply, socialSettings, ticketThreads, verifyToken, type Via,
} from "../lib/meta";
import { HttpError, getSetting, randomId } from "../lib/util";

const social = new Hono<AppEnv>();
const STATE_COOKIE = "hd_meta_state";
const origin = (url: string) => new URL(url).origin;
const redirectUri = (url: string) => `${origin(url)}/api/social/callback`;

/** Everything Settings shows: setup values to paste into Meta, the connection, and what becomes a ticket. */
social.get("/status", async (c) => {
  requireAdmin(c);
  const conn = await metaConnection(c.env);
  const pending = await pendingPages(c.env);
  return c.json({
    configured: metaConfigured(c.env),
    appId: c.env.META_APP_ID ?? null,
    graphVersion: graphVersion(c.env),
    redirectUri: redirectUri(c.req.url),
    webhookUrl: `${origin(c.req.url)}/meta/webhook`,
    verifyToken: await verifyToken(c.env),
    connection: conn ? { pageId: conn.pageId, pageName: conn.pageName, igId: conn.igId, igUsername: conn.igUsername, connectedAt: conn.connectedAt, subscribed: conn.subscribed } : null,
    pending: pending.map((p) => ({ id: p.id, name: p.name, igUsername: p.igUsername })),
    lastEvent: await getSetting<string | null>(c.env, "meta_last_event", null),
    settings: await socialSettings(c.env),
  });
});

social.put("/settings", async (c) => {
  requireAdmin(c);
  return c.json({ settings: await saveSocialSettings(c.env, await c.req.json()) });
});

/** Facebook Login: pick the Page (and its Instagram account) and allow the help desk to read and answer. */
social.get("/connect", (c) => {
  requireAdmin(c);
  if (!metaConfigured(c.env)) throw new HttpError(409, "Add the Meta App ID and App secret first");
  const state = randomId(16);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: c.req.url.startsWith("https:"), sameSite: "Lax", path: "/api/social", maxAge: 600 });
  return c.redirect(loginUrl(c.env, redirectUri(c.req.url), state));
});

social.get("/callback", async (c) => {
  requireAdmin(c);
  const back = (q: string) => c.redirect(`/settings/social?${q}`);
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/social" });
  if (c.req.query("error")) return back("meta=cancelled");
  if (!expected || c.req.query("state") !== expected) return back("meta=expired");
  try {
    const pages = await pagesFromCode(c.env, c.req.query("code") ?? "", redirectUri(c.req.url));
    if (!pages.length) return back("meta=nopages");
    if (pages.length === 1) {
      await connectPage(c.env, pages[0], origin(c.req.url));
      return back("meta=connected");
    }
    await savePendingPages(c.env, pages);
    return back("meta=pick");
  } catch (e) {
    return back(`meta=error&message=${encodeURIComponent((e as Error).message.slice(0, 200))}`);
  }
});

social.post("/pages/:id", async (c) => {
  requireAdmin(c);
  const page = (await pendingPages(c.env)).find((p) => p.id === c.req.param("id"));
  if (!page) throw new HttpError(404, "That choice expired — connect again");
  await connectPage(c.env, page, origin(c.req.url));
  return c.json({ ok: true });
});

/** Re-asks Meta to send comments and messages here (e.g. after changing the app). */
social.post("/resubscribe", async (c) => {
  requireAdmin(c);
  const conn = await metaConnection(c.env);
  if (!conn) throw new HttpError(409, "Not connected");
  const s = await connectPage(c.env, { id: conn.pageId, name: conn.pageName, token: conn.token, igId: conn.igId, igUsername: conn.igUsername }, origin(c.req.url));
  return c.json({ subscribed: s.subscribed });
});

social.post("/disconnect", async (c) => {
  requireAdmin(c);
  await disconnectMeta(c.env);
  return c.json({ ok: true });
});

/** A social ticket's context: the post it's about, and how a reply can go out. */
social.get("/ticket/:tid{[0-9]+}", async (c) => {
  const id = Number(c.req.param("tid"));
  const threads = await ticketThreads(c.env, id);
  if (!threads.length) throw new HttpError(404, "Not an Instagram or Facebook ticket");
  const main = threads.find((t) => t.kind === "comment") ?? threads[0];
  return c.json({
    platform: main.platform,
    kind: main.kind,
    user: { id: main.user_id, name: main.user_name },
    post: main.post_id ? { caption: main.post_caption, url: main.post_url, image: main.post_image } : null,
    options: replyOptions(threads, await privateRepliesUsed(c.env, id)),
    connected: !!(await metaConnection(c.env)),
  });
});

social.post("/ticket/:tid{[0-9]+}/send", async (c) => {
  const body = await c.req.json<{ text?: string; via?: Via }>();
  const via = (["public", "private", "dm"] as const).find((v) => v === body.via);
  if (!via) throw new HttpError(400, "Say how to send it");
  const me = c.get("agent");
  return c.json(await sendSocialReply(c.env, Number(c.req.param("tid")), { id: me.id, name: me.name }, String(body.text ?? ""), via));
});

export default social;
