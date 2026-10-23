import type { Context } from "hono";
import type { AppEnv } from "../env";
import { buildHubCards, HUB_APP, hubAuthStatus, hubPeriods, type HubPeriods, type HubStats } from "../lib/hub-summary";

const iso = (ms: number) => new Date(ms).toISOString();

/** A handful of aggregate queries over this week and this month (store time). */
export async function loadHubStats(db: D1Database, p: HubPeriods): Promise<HubStats> {
  const until = iso(p.now + 1000);
  const [solved, replies, chats, labels] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN closed_at >= ?1 AND closed_at < ?2 THEN 1 ELSE 0 END), 0) AS cur,
              COALESCE(SUM(CASE WHEN closed_at >= ?3 AND closed_at < ?4 THEN 1 ELSE 0 END), 0) AS prev
       FROM tickets WHERE status IN ('closed','archived') AND closed_at >= ?3`,
    ).bind(iso(p.weekStart), until, iso(p.prevWeekStart), iso(p.prevWeekUntil)).first<{ cur: number; prev: number }>(),
    // Email tickets opened this week: hours to the first reply a teammate sent (automatic replies have no teammate)
    db.prepare(
      `SELECT (julianday(MIN(m.sent_at)) - julianday(t.created_at)) * 24 AS hours
       FROM tickets t JOIN messages m ON m.ticket_id = t.id AND m.direction = 'out' AND m.kind IS NULL AND m.agent_id IS NOT NULL AND m.sent_at > t.created_at
       WHERE t.channel = 'email' AND t.created_at >= ?1 AND t.created_at < ?2 AND t.status NOT IN ('spam','deleted') GROUP BY t.id`,
    ).bind(iso(p.weekStart), until).all<{ hours: number }>(),
    // Live chats started in the period that got an answer from a teammate or the chat assistant
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN c.created_at >= ?1 AND c.created_at < ?2 THEN 1 ELSE 0 END), 0) AS cur,
              COALESCE(SUM(CASE WHEN c.created_at >= ?3 AND c.created_at < ?4 THEN 1 ELSE 0 END), 0) AS prev
       FROM chats c JOIN tickets t ON t.id = c.ticket_id
       WHERE c.created_at >= ?3 AND t.status NOT IN ('spam','deleted')
         AND EXISTS (SELECT 1 FROM messages m WHERE m.ticket_id = c.ticket_id AND m.direction = 'out' AND m.kind IN ('chat','chat_ai'))`,
    ).bind(iso(p.monthStart), until, iso(p.prevMonthStart), iso(p.prevMonthUntil)).first<{ cur: number; prev: number }>(),
    // One label per box, counted the way the dashboard does
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END), 0) AS n
       FROM shipments WHERE status = 'purchased' AND created_at >= ?1 AND created_at < ?2`,
    ).bind(iso(p.weekStart), until).first<{ n: number }>(),
  ]);
  return {
    solvedWeek: Number(solved?.cur ?? 0),
    solvedPrevWeek: Number(solved?.prev ?? 0),
    firstReplyHours: (replies.results ?? []).map((r) => Number(r.hours)),
    chatsMonth: Number(chats?.cur ?? 0),
    chatsPrevMonth: Number(chats?.prev ?? 0),
    labelsWeek: Number(labels?.n ?? 0),
  };
}

/** GET /api/hub-summary — good-news cards for the Tuft Life hub. Bearer token only; no agent session. */
export async function hubSummary(c: Context<AppEnv>) {
  const env = c.env.RAW_ENV ?? c.env; // only the Worker secret counts, never an app-entered value
  const status = await hubAuthStatus(env.HUB_SUMMARY_TOKEN, c.req.header("authorization"));
  const headers = { "cache-control": "no-store" };
  if (status === 503) return c.json({ error: "not configured" }, 503, headers);
  if (status === 401) return c.json({ error: "unauthorized" }, 401, headers);
  try {
    const now = Date.now();
    const cards = buildHubCards(await loadHubStats(c.env.DB, hubPeriods(now)));
    return c.json({ app: HUB_APP, generatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"), cards }, 200, headers);
  } catch (e) {
    console.error("Hub summary failed", e);
    return c.json({ error: "summary unavailable" }, 500, headers);
  }
}
