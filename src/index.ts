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
import { sweepChats } from "./lib/chat";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "Something went wrong: " + (err as Error).message }, 500);
});

app.route("/auth", authRoutes);
app.route("/chat-api", chatPublicRoutes);

const api = new Hono<AppEnv>();
api.use("*", requireAgent);
api.route("/tickets", ticketRoutes);
api.route("/shipping", shippingRoutes);
api.route("/analytics", analyticsRoutes);
api.route("/manual", manualRoutes);
api.route("/rate-check", rateCheckRoutes);
api.route("/chats", chatRoutes);
api.route("/", adminRoutes);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Raw env stays reachable for the credentials screen, which must tell app-entered from Cloudflare values
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/") && !path.startsWith("/chat-api/")) return app.fetch(request, env, ctx);
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
      ]).then(() => runBackfill(merged).catch((e) => console.error("Backfill failed", e))),
    );
  },
} satisfies ExportedHandler<Env>;
