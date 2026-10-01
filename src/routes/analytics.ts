import { Hono } from "hono";
import type { AppEnv } from "../env";

const analytics = new Hono<AppEnv>();

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Shipping cost vs what customers paid, fulfillment speed, and support volume for a period. */
analytics.get("/", async (c) => {
  const ytd = c.req.query("days") === "ytd";
  let days: number, since: string, prevSince: string, prevUntil: string;
  if (ytd) {
    // Year to date in store time (Philadelphia), compared with the same stretch of last year
    const year = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date()));
    const jan1 = (y: number) => new Date(`${y}-01-01T05:00:00Z`).getTime(); // midnight EST
    since = new Date(jan1(year)).toISOString();
    prevSince = new Date(jan1(year - 1)).toISOString();
    prevUntil = new Date(jan1(year - 1) + (Date.now() - jan1(year))).toISOString();
    days = Math.max(1, Math.ceil((Date.now() - jan1(year)) / 86400_000));
  } else {
    days = Math.min(730, Math.max(1, Number(c.req.query("days")) || 30));
    since = new Date(Date.now() - days * 86400_000).toISOString();
    prevSince = new Date(Date.now() - 2 * days * 86400_000).toISOString();
    prevUntil = since;
  }
  const db = c.env.DB;

  const shippingTotals = (from: string, to: string) =>
    db.prepare(
      `SELECT SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END) AS labels, COUNT(*) AS orders, COALESCE(SUM(cost), 0) AS spend, COALESCE(SUM(shipping_paid), 0) AS collected,
              COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin,
              COALESCE(SUM(CASE WHEN list_cost IS NOT NULL THEN list_cost - cost END), 0) AS saved,
              SUM(cost) / NULLIF(SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END), 0) AS avg_cost,
              AVG(CASE WHEN order_created_at IS NOT NULL THEN (julianday(created_at) - julianday(order_created_at)) * 24 END) AS hours_to_ship,
              SUM(CASE WHEN shipping_paid IS NOT NULL AND shipping_paid < cost THEN 1 ELSE 0 END) AS losers,
              SUM(scan_verified) AS verified
       FROM shipments WHERE status = 'purchased' AND created_at >= ? AND created_at < ?`,
    ).bind(from, to);

  const now = new Date(Date.now() + 1000).toISOString();
  const [cur, prev, weekly, services, states, voided, recent, ticketsCreated, ticketsClosed, openNow, firstResponses, daily] = await db.batch([
    shippingTotals(since, now),
    shippingTotals(prevSince, prevUntil),
    db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at, 'weekday 0', '-6 days') AS week, SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END) AS labels, COUNT(*) AS orders, SUM(cost) AS spend,
              COALESCE(SUM(shipping_paid), 0) AS collected, COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY week ORDER BY week`,
    ).bind(since),
    db.prepare(
      `SELECT service_name, SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END) AS labels, COUNT(*) AS orders, SUM(cost) AS spend, SUM(cost) / NULLIF(SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END), 0) AS avg_cost,
              COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY service_name ORDER BY labels DESC`,
    ).bind(since),
    db.prepare(
      `SELECT COALESCE(dest_state, '—') AS state, SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END) AS labels, COUNT(*) AS orders, SUM(cost) / NULLIF(SUM(CASE WHEN json_valid(packages) AND json_array_length(packages) > 0 THEN json_array_length(packages) ELSE 1 END), 0) AS avg_cost
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY dest_state ORDER BY labels DESC LIMIT 8`,
    ).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM shipments WHERE status = 'voided' AND created_at >= ?`).bind(since),
    db.prepare(
      `SELECT id, order_name, service_name, cost, shipping_paid, requested_service, created_at, signature
       FROM shipments WHERE status = 'purchased' AND created_at >= ? ORDER BY created_at DESC LIMIT 25`,
    ).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND status NOT IN ('spam','deleted')`).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status IN ('closed','archived') AND closed_at >= ?`).bind(since),
    db.prepare(`SELECT SUM(status = 'open') AS open, SUM(status = 'in_progress') AS in_progress, SUM(status = 'snoozed') AS snoozed FROM tickets`),
    // Hours from a ticket's first message to our first reply
    db.prepare(
      `SELECT (julianday(MIN(m.sent_at)) - julianday(t.created_at)) * 24 AS hours
       FROM tickets t JOIN messages m ON m.ticket_id = t.id AND m.direction = 'out' AND m.sent_at > t.created_at
       WHERE t.created_at >= ? GROUP BY t.id`,
    ).bind(since),
    db.prepare(
      `SELECT day, SUM(c) AS created, SUM(x) AS closed FROM (
         SELECT substr(created_at, 1, 10) AS day, 1 AS c, 0 AS x FROM tickets WHERE created_at >= ?1 AND status NOT IN ('spam','deleted')
         UNION ALL
         SELECT substr(closed_at, 1, 10), 0, 1 FROM tickets WHERE closed_at >= ?1 AND status IN ('closed','archived')
       ) GROUP BY day ORDER BY day`,
    ).bind(since),
  ]);

  // Support detail: resolution time, busiest hours, touches, per-teammate numbers
  const [resolved, createdTimes, touches, team] = await db.batch([
    db.prepare(
      `SELECT (julianday(resolved_at) - julianday(created_at)) * 24 AS hours FROM tickets
       WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND status NOT IN ('spam','deleted')`,
    ).bind(since),
    db.prepare(`SELECT created_at FROM tickets WHERE created_at >= ? AND status NOT IN ('spam','deleted')`).bind(since),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM messages m WHERE m.ticket_id = t.id AND m.direction = 'out') AS replies FROM tickets t
       WHERE t.resolved_at IS NOT NULL AND t.resolved_at >= ? AND t.status IN ('closed','archived')`,
    ).bind(since),
    db.prepare(
      `SELECT a.id, a.name,
         (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = a.id AND t.status IN ('open','in_progress')) AS active,
         (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.sent_at >= ?1) AS replies,
         (SELECT COUNT(*) FROM events e WHERE e.agent_id = a.id AND e.kind = 'status' AND e.detail LIKE 'closed%' AND e.created_at >= ?1) AS closed,
         (SELECT COUNT(DISTINCT m.ticket_id) FROM messages m WHERE m.agent_id = a.id AND m.direction = 'out' AND m.sent_at >= ?1) AS tickets_replied
       FROM agents a WHERE a.active = 1 ORDER BY replies DESC, a.name`,
    ).bind(since),
  ]);
  const resHours = (resolved.results as { hours: number }[]).map((r) => r.hours).filter((h) => h >= 0);
  // Weekday × hour in the store's time zone
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const r of createdTimes.results as { created_at: string }[]) {
    const parts = fmt.formatToParts(new Date(r.created_at));
    const wd = WD.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
    const hr = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    if (wd >= 0) heat[wd][hr]++;
  }
  const touchCounts = (touches.results as { replies: number }[]).map((r) => r.replies);
  const oneTouch = touchCounts.filter((n) => n === 1).length;

  const frt = (firstResponses.results as { hours: number }[]).map((r) => r.hours).filter((h) => h >= 0);
  return c.json({
    days,
    ytd,
    shipping: { current: cur.results[0], previous: prev.results[0], voided: (voided.results[0] as any).n },
    weekly: weekly.results,
    services: services.results,
    states: states.results,
    recent: recent.results,
    support: {
      created: (ticketsCreated.results[0] as any).n,
      closed: (ticketsClosed.results[0] as any).n,
      open: (openNow.results[0] as any).open ?? 0,
      inProgress: (openNow.results[0] as any).in_progress ?? 0,
      snoozed: (openNow.results[0] as any).snoozed ?? 0,
      medianFirstReplyHours: median(frt),
      replied: frt.length,
      medianResolutionHours: median(resHours),
      resolved: resHours.length,
      avgTouches: touchCounts.length ? touchCounts.reduce((a, b) => a + b, 0) / touchCounts.length : null,
      oneTouchRate: touchCounts.length ? oneTouch / touchCounts.length : null,
      heatmap: heat,
      team: team.results,
      daily: daily.results,
    },
  });
});

export default analytics;
