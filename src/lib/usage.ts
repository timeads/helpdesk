// AI usage tracking: every AI call adds its token counts (from the response's usage) to a per-day,
// per-feature, per-model row, and the dashboard prices them.
import type { Env } from "../env";

/** Anthropic list prices, US dollars per million tokens (first-party API). Update if prices change. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** Prices for a model id as the API reports it (dated or prefixed variants match their family). */
export function priceFor(model: string) {
  const id = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => model.includes(k));
  return id ? PRICES[id] : PRICES["claude-opus-5-5"]; // unknown: price as the default model, so it's never under-counted
}

export interface Usage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

export const costOf = (model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => {
  const p = priceFor(model);
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
};

/** Adds one response's tokens to today's row. Never throws: tracking must not break the feature. */
export async function recordUsage(env: Env, feature: string, model: string | undefined, usage: Usage | undefined | null) {
  if (!usage) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO ai_usage (day, feature, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(day, feature, model) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens, cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
    ).bind(day, feature.slice(0, 60), model || env.AI_MODEL || "unknown", usage.input_tokens ?? 0, usage.output_tokens ?? 0, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0).run();
  } catch (e) {
    console.error("usage tracking", e);
  }
}

/** Features that are one-time work, reported on their own and left out of the monthly estimate. */
export const ONE_TIME = ["Repair manual backlog"];
/** New repair emails expected each month (they're read into the manual as they come in). */
export const REPAIRS_PER_MONTH = { low: 1, high: 3 };

/** Spend for the dashboard: today, this month, last 30 days by day, and this month by feature and model. */
export async function usageReport(env: Env, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = new Date(now.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const since = from < monthStart ? from : monthStart;
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT * FROM ai_usage WHERE day >= ? ORDER BY day").bind(since < prevStart ? since : prevStart)
    .all<{ day: string; feature: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }>();
  const cost = (r: (typeof results)[number]) => costOf(r.model, { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens });
  const byDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) byDay.set(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10), 0);
  const features = new Map<string, { cost: number; calls: number; tokens: number }>();
  const models = new Map<string, { cost: number; calls: number }>();
  let month = 0, todayCost = 0, prevMonth = 0, monthCalls = 0, monthTokens = 0;
  for (const r of results) {
    const c = cost(r);
    if (byDay.has(r.day)) byDay.set(r.day, byDay.get(r.day)! + c);
    if (r.day === today) todayCost += c;
    if (r.day >= prevStart && r.day < monthStart) prevMonth += c;
    if (r.day >= monthStart) {
      month += c;
      monthCalls += r.calls;
      monthTokens += r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
      const f = features.get(r.feature) ?? { cost: 0, calls: 0, tokens: 0 };
      features.set(r.feature, { cost: f.cost + c, calls: f.calls + r.calls, tokens: f.tokens + r.input_tokens + r.output_tokens });
      const m = models.get(r.model) ?? { cost: 0, calls: 0 };
      models.set(r.model, { cost: m.cost + c, calls: m.calls + r.calls });
    }
  }
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  // ---- One-time work (reading the old support email into the repair manual), kept out of the estimate
  const backlogRow = await env.DB.prepare(
    `SELECT model, SUM(calls) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw,
            MIN(day) AS first, MAX(day) AS last FROM ai_usage WHERE feature IN (${ONE_TIME.map(() => "?").join(",")}) GROUP BY model`,
  ).bind(...ONE_TIME).all<{ model: string; calls: number; i: number; o: number; cr: number; cw: number; first: string; last: string }>();
  const backlogCost = backlogRow.results.reduce((n, r) => n + costOf(r.model, { input: r.i, output: r.o, cacheRead: r.cr, cacheWrite: r.cw }), 0);
  const read = await env.DB.prepare("SELECT COUNT(*) AS n FROM manual_scanned").first<{ n: number }>().catch(() => null);
  const conversations = read?.n ?? 0;
  const perConversation = conversations ? backlogCost / conversations : null;
  const backlogMonth = results.filter((r) => ONE_TIME.includes(r.feature) && r.day >= monthStart).reduce((n, r) => n + cost(r), 0);

  // ---- Everyday use: the daily rate over the last 14 days (or since tracking began), without the one-time work
  const first = await env.DB.prepare("SELECT MIN(day) AS d FROM ai_usage").first<{ d: string | null }>();
  const windowStart = new Date(now.getTime() - 13 * 86400_000).toISOString().slice(0, 10);
  const basisFrom = first?.d && first.d > windowStart ? first.d : windowStart;
  const basisDays = Math.max(1, Math.round((Date.parse(today) - Date.parse(basisFrom)) / 86400_000) + 1);
  const everyday = results.filter((r) => !ONE_TIME.includes(r.feature) && r.day >= basisFrom && r.day <= today).reduce((n, r) => n + cost(r), 0);
  const daily = everyday / basisDays;
  // A few new repair emails a month (1–3) still get read into the manual
  const repairs = perConversation === null ? null : { low: perConversation * REPAIRS_PER_MONTH.low, high: perConversation * REPAIRS_PER_MONTH.high };
  const typical = { low: daily * 30 + (repairs?.low ?? 0), high: daily * 30 + (repairs?.high ?? 0) };

  return {
    today: todayCost,
    month,
    // This month: what's been spent, plus everyday use for the days left (one-time work isn't expected to repeat)
    projected: month + daily * Math.max(0, daysInMonth - dayOfMonth),
    everyday: { daily, basisDays, typical, repairs, perMonthRepairs: REPAIRS_PER_MONTH },
    backlog: { cost: backlogCost, calls: backlogRow.results.reduce((n, r) => n + r.calls, 0), conversations, perConversation, month: backlogMonth,
      first: backlogRow.results.reduce<string | null>((m, r) => (!m || r.first < m ? r.first : m), null), last: backlogRow.results.reduce<string | null>((m, r) => (!m || r.last > m ? r.last : m), null) },
    prevMonth,
    monthCalls,
    monthTokens,
    days: [...byDay].map(([day, cost]) => ({ day, cost })),
    features: [...features].map(([name, v]) => ({ name, ...v, oneTime: ONE_TIME.includes(name) })).sort((a, b) => b.cost - a.cost),
    models: [...models].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cost - a.cost),
  };
}
