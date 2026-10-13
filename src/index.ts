import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { requireAgent } from "./lib/auth";
import { runBackfill, syncMailbox } from "./lib/gmail";
import { wakeSnoozed } from "./lib/support";
import { HttpError } from "./lib/util";
import { withCredentials } from "./lib/credentials";
import authRoutes from "./routes/auth";
import ticketRoutes from "./routes/tickets";
import shippingRoutes from "./routes/shipping";
import adminRoutes from "./routes/admin";
import analyticsRoutes from "./routes/analytics";
import manualRoutes from "./routes/manual";
import rateCheckRoutes from "./routes/ratecheck";
import chatPublicRoutes from "./routes/chat-public";
import chatRoutes from "./routes/chat";
import kbRoutes from "./routes/kb";
import socialRoutes from "./routes/social";
import { handleWebhook, validSignature, verifyToken } from "./lib/meta";
import { sweepChats } from "./lib/chat";
import { dailyRefresh } from "./lib/site-knowledge";
import { autoMergeTick } from "./lib/kb-merge";
import { suggestTick } from "./lib/suggest";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "Something went wrong: " + (err as Error).message }, 500);
});

app.route("/auth", authRoutes);
app.route("/chat-api", chatPublicRoutes);

// Meta (Instagram & Facebook) webhook: the address check, then signed deliveries of new comments and messages
app.get("/meta/webhook", async (c) => {
  if (c.req.query("hub.mode") !== "subscribe" || c.req.query("hub.verify_token") !== (await verifyToken(c.env))) return c.text("Forbidden", 403);
  return c.text(c.req.query("hub.challenge") ?? "");
});
app.post("/meta/webhook", async (c) => {
  const raw = await c.req.text();
  if (!(await validSignature(c.env, raw, c.req.header("x-hub-signature-256")))) return c.text("Bad signature", 401);
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return c.text("Bad JSON", 400); }
  // Answer Meta straight away; photos are downloaded and tickets made after
  c.executionCtx.waitUntil(handleWebhook(c.env, payload).catch((e) => console.error("Meta webhook failed", e)));
  return c.text("OK");
});

// Knowledge-base photos: public, because the store's articles show them
app.get("/kb/img/:id{[0-9]+}", async (c) => {
  const r = await c.env.DB.prepare("SELECT mime, data FROM kb_images WHERE id = ?").bind(Number(c.req.param("id"))).first<{ mime: string; data: string }>();
  if (!r) return c.text("Not found", 404);
  const bin = atob(r.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { "content-type": r.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
});

const api = new Hono<AppEnv>();
api.use("*", requireAgent);
api.route("/tickets", ticketRoutes);
api.route("/shipping", shippingRoutes);
api.route("/analytics", analyticsRoutes);
api.route("/manual", manualRoutes);
api.route("/rate-check", rateCheckRoutes);
api.route("/chats", chatRoutes);
api.route("/kb", kbRoutes);
api.route("/social", socialRoutes);
api.route("/", adminRoutes);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Raw env stays reachable for the credentials screen, which must tell app-entered from Cloudflare values
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/chat-api/") && !path.startsWith("/meta/")) return app.fetch(request, env, ctx);
    const merged = await withCredentials(env);
    // Layer RAW_ENV on top without copying (copies can lose secret bindings)
    const withRaw = Object.create(merged) as Env;
    withRaw.RAW_ENV = env;
    return app.fetch(request, withRaw, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const merged = await withCredentials(env);
    ctx.waitUntil(
      Promise.all([
        syncMailbox(merged).catch((e) => console.error("Mail sync failed", e)),
        wakeSnoozed(merged).catch((e) => console.error("Snooze wake failed", e)),
        sweepChats(merged).catch((e) => console.error("Chat sweep failed", e)),
        dailyRefresh(merged).catch((e) => console.error("Website knowledge refresh failed", e)),
        autoMergeTick(merged).catch((e) => console.error("Knowledge base auto-merge failed", e)),
      ])
        .then(() => suggestTick(merged).catch((e) => console.error("Suggested replies failed", e))) // after mail sync, so new emails are in
        .then(() => runBackfill(merged).catch((e) => console.error("Backfill failed", e))),
    );
  },
} satisfies ExportedHandler<Env>;
