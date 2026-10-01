import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { requireAgent } from "./lib/auth";
import { syncMailbox } from "./lib/gmail";
import { HttpError } from "./lib/util";
import { withCredentials } from "./lib/credentials";
import authRoutes from "./routes/auth";
import ticketRoutes from "./routes/tickets";
import shippingRoutes from "./routes/shipping";
import adminRoutes from "./routes/admin";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "Something went wrong: " + (err as Error).message }, 500);
});

app.route("/auth", authRoutes);

const api = new Hono<AppEnv>();
api.use("*", requireAgent);
api.route("/tickets", ticketRoutes);
api.route("/shipping", shippingRoutes);
api.route("/", adminRoutes);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Raw env stays reachable for the credentials screen, which must tell app-entered from Cloudflare values
    const merged = new URL(request.url).pathname.startsWith("/api/") ? { ...(await withCredentials(env)), RAW_ENV: env } : env;
    return app.fetch(request, merged as Env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncMailbox(await withCredentials(env)).catch((e) => {
        console.error("Mail sync failed", e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
