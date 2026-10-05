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
