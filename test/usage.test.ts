import { beforeEach, describe, expect, it } from "vitest";
import { testD1 } from "./helpers/d1";
import { costOf, priceFor, recordUsage, usageReport } from "../src/lib/usage";

let env: any;
beforeEach(() => { env = { DB: testD1() }; });

describe("AI usage tracking", () => {
  it("prices tokens per model, matching dated or prefixed ids", () => {
    expect(priceFor("claude-opus-5-5")).toMatchObject({ input: 4, output: 20 });
    expect(priceFor("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5 });
    expect(priceFor("claude-sonnet-5-5")).toMatchObject({ input: 2, output: 10 });
    expect(priceFor("something-new").input).toBe(4); // unknown: priced like the default, never under-counted
    expect(costOf("claude-opus-5-5", { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(6);
  });

  it("adds each call to today's row per feature and model, and reports by day, feature and month", async () => {
    await recordUsage(env, "Website chat", "claude-opus-5-5", { input_tokens: 10_000, output_tokens: 1_000 });
    await recordUsage(env, "Website chat", "claude-opus-5-5", { input_tokens: 10_000, output_tokens: 1_000, cache_read_input_tokens: 5_000 });
    await recordUsage(env, "Suggested replies", "claude-opus-5-5", { input_tokens: 20_000, output_tokens: 2_000 });
    await recordUsage(env, "Help & Guides", undefined, null); // no usage: ignored
    const row = await env.DB.prepare("SELECT * FROM ai_usage WHERE feature = 'Website chat'").first();
    expect(row).toMatchObject({ calls: 2, input_tokens: 20_000, output_tokens: 2_000, cache_read_tokens: 5_000 });
    const r = await usageReport(env);
    const chat = 0.02 * 4 + 0.002 * 20 + 0.005 * 0.2; // $0.121
    const replies = 0.02 * 4 + 0.002 * 20; // $0.12
    expect(r.today).toBeCloseTo(chat + replies);
    expect(r.month).toBeCloseTo(chat + replies);
    expect(r.monthCalls).toBe(3);
    expect(r.days).toHaveLength(30);
    expect(r.days.at(-1)!.cost).toBeCloseTo(chat + replies);
    expect(r.features.map((f) => f.name)).toEqual(["Website chat", "Suggested replies"]);
  });
});

describe("monthly estimate", () => {
  it("keeps the one-time backlog out of it, and adds 1–3 new repair emails a month", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const add = (day: string, feature: string, input: number, output: number) =>
      env.DB.raw.prepare("INSERT INTO ai_usage (day, feature, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, 'claude-opus-5-5', 1, ?, ?, 0, 0)").run(day, feature, input, output);
    // Backlog: $40 over two days early in the month (and $10 last month)
    add("2026-09-28", "Repair manual backlog", 2_500_000, 0);
    add("2026-10-02", "Repair manual backlog", 5_000_000, 500_000);
    add("2026-10-03", "Repair manual backlog", 2_500_000, 0);
    // Everyday: $0.10 a day for the last 14 days
    for (let d = 7; d <= 20; d++) add(`2026-10-${String(d).padStart(2, "0")}`, "Website chat", 25_000, 0);
    for (let i = 0; i < 100; i++) env.DB.raw.prepare("INSERT INTO manual_scanned (ticket_id, result) VALUES (?, 'repair')").run(1000 + i);
    const r = await usageReport(env, now);
    expect(r.backlog).toMatchObject({ conversations: 100, first: "2026-09-28", last: "2026-10-03", calls: 3 });
    expect(r.backlog.cost).toBeCloseTo(10 + 30 + 10);
    expect(r.backlog.perConversation).toBeCloseTo(0.5);
    expect(r.backlog.month).toBeCloseTo(40);
    expect(r.everyday.daily).toBeCloseTo(0.1);
    expect(r.everyday.basisDays).toBe(14);
    expect(r.month).toBeCloseTo(40 + 1.4);
    expect(r.projected).toBeCloseTo(40 + 1.4 + 0.1 * 11); // the backlog isn't expected to repeat
    expect(r.everyday.typical.low).toBeCloseTo(3 + 0.5);
    expect(r.everyday.typical.high).toBeCloseTo(3 + 1.5);
    expect(r.features.find((f) => f.name === "Repair manual backlog")!.oneTime).toBe(true);
  });
});
