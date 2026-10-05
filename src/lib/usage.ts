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
  return {
    today: todayCost,
    month,
    projected: dayOfMonth ? (month / dayOfMonth) * daysInMonth : month,
    prevMonth,
    monthCalls,
    monthTokens,
    days: [...byDay].map(([day, cost]) => ({ day, cost })),
    features: [...features].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cost - a.cost),
    models: [...models].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cost - a.cost),
  };
}
