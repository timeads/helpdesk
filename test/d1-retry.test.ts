import { describe, expect, it } from "vitest";
import { retryingD1 } from "../src/lib/d1-retry";

/** A fake database whose queries fail with `error` the first `fails` times. */
function flaky(fails: number, error = "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window") {
  let calls = 0;
  const stmt: any = {
    bind: () => stmt,
    first: async () => { calls++; if (calls <= fails) throw new Error(error); return { n: 1 }; },
  };
  const db: any = { prepare: () => stmt, batch: async (s: unknown[]) => { calls++; if (calls <= fails) throw new Error(error); return s.map(() => ({ results: [] })); } };
  return { db: retryingD1(db), calls: () => calls };
}

describe("database retry on 'overloaded'", () => {
  it("waits and tries again when the database is briefly overloaded", async () => {
    const f = flaky(2);
    expect(await f.db.prepare("SELECT 1").bind(1).first()).toEqual({ n: 1 });
    expect(f.calls()).toBe(3);
    const g = flaky(1);
    expect(await g.db.batch([g.db.prepare("SELECT 1")])).toHaveLength(1);
  });

  it("gives up after a few tries, and never retries other errors", async () => {
    await expect(flaky(10).db.prepare("SELECT 1").first()).rejects.toThrow(/overloaded/);
    const other = flaky(1, "D1_ERROR: UNIQUE constraint failed");
    await expect(other.db.prepare("INSERT").first()).rejects.toThrow(/UNIQUE/);
    expect(other.calls()).toBe(1);
  });
});
