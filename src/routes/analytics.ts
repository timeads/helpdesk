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
  const days = Math.min(730, Math.max(1, Number(c.req.query("days")) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const prevSince = new Date(Date.now() - 2 * days * 86400_000).toISOString();
  const db = c.env.DB;

  const shippingTotals = (from: string, to: string) =>
    db.prepare(
      `SELECT COUNT(*) AS labels, COALESCE(SUM(cost), 0) AS spend, COALESCE(SUM(shipping_paid), 0) AS collected,
              COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin,
              COALESCE(SUM(CASE WHEN list_cost IS NOT NULL THEN list_cost - cost END), 0) AS saved,
              AVG(cost) AS avg_cost,
              AVG(CASE WHEN order_created_at IS NOT NULL THEN (julianday(created_at) - julianday(order_created_at)) * 24 END) AS hours_to_ship,
              SUM(CASE WHEN shipping_paid IS NOT NULL AND shipping_paid < cost THEN 1 ELSE 0 END) AS losers,
              SUM(scan_verified) AS verified
       FROM shipments WHERE status = 'purchased' AND created_at >= ? AND created_at < ?`,
    ).bind(from, to);

  const now = new Date(Date.now() + 1000).toISOString();
  const [cur, prev, weekly, services, states, voided, recent, ticketsCreated, ticketsClosed, openNow, firstResponses, daily] = await db.batch([
    shippingTotals(since, now),
    shippingTotals(prevSince, since),
    db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at, 'weekday 0', '-6 days') AS week, COUNT(*) AS labels, SUM(cost) AS spend,
              COALESCE(SUM(shipping_paid), 0) AS collected, COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY week ORDER BY week`,
    ).bind(since),
    db.prepare(
      `SELECT service_name, COUNT(*) AS labels, SUM(cost) AS spend, AVG(cost) AS avg_cost,
              COALESCE(SUM(CASE WHEN shipping_paid IS NOT NULL THEN shipping_paid - cost END), 0) AS margin
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY service_name ORDER BY labels DESC`,
    ).bind(since),
    db.prepare(
      `SELECT COALESCE(dest_state, '—') AS state, COUNT(*) AS labels, AVG(cost) AS avg_cost
       FROM shipments WHERE status = 'purchased' AND created_at >= ? GROUP BY dest_state ORDER BY labels DESC LIMIT 8`,
    ).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM shipments WHERE status = 'voided' AND created_at >= ?`).bind(since),
    db.prepare(
      `SELECT id, order_name, service_name, cost, shipping_paid, requested_service, created_at, signature
       FROM shipments WHERE status = 'purchased' AND created_at >= ? ORDER BY created_at DESC LIMIT 25`,
    ).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?`).bind(since),
    db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE status = 'closed' AND closed_at >= ?`).bind(since),
    db.prepare(`SELECT SUM(status = 'open') AS open, SUM(status = 'pending') AS pending FROM tickets`),
    // Hours from a ticket's first message to our first reply
    db.prepare(
      `SELECT (julianday(MIN(m.sent_at)) - julianday(t.created_at)) * 24 AS hours
       FROM tickets t JOIN messages m ON m.ticket_id = t.id AND m.direction = 'out' AND m.sent_at > t.created_at
       WHERE t.created_at >= ? GROUP BY t.id`,
    ).bind(since),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS created FROM tickets WHERE created_at >= ? GROUP BY day ORDER BY day`,
    ).bind(since),
  ]);

  const frt = (firstResponses.results as { hours: number }[]).map((r) => r.hours).filter((h) => h >= 0);
  return c.json({
    days,
    shipping: { current: cur.results[0], previous: prev.results[0], voided: (voided.results[0] as any).n },
    weekly: weekly.results,
    services: services.results,
    states: states.results,
    recent: recent.results,
    support: {
      created: (ticketsCreated.results[0] as any).n,
      closed: (ticketsClosed.results[0] as any).n,
      open: (openNow.results[0] as any).open ?? 0,
      pending: (openNow.results[0] as any).pending ?? 0,
      medianFirstReplyHours: median(frt),
      replied: frt.length,
      daily: daily.results,
    },
  });
});

export default analytics;
