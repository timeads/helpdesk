import { Hono } from "hono";
import type { AppEnv } from "../env";
import { checkNext, checkResults } from "../lib/ratecheck";

const rateCheck = new Hono<AppEnv>();

rateCheck.get("/", async (c) => c.json({ rows: await checkResults(c.env) }));

/** Re-quotes the next few Redo shipments ({ days, limit, restart }); the page repeats until remaining is 0. */
rateCheck.post("/run", async (c) => {
  const body = await c.req.json<{ days?: number; limit?: number; restart?: boolean }>().catch(() => ({}) as { days?: number; limit?: number; restart?: boolean });
  if (body.restart) await c.env.DB.prepare("DELETE FROM rate_checks").run();
  const days = Math.min(730, Math.max(1, Number(body.days) || 90));
  const limit = Math.min(500, Math.max(1, Number(body.limit) || 150));
  return c.json(await checkNext(c.env, { days, limit }));
});

export default rateCheck;
