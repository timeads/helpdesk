import { describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";
import * as manual from "../src/lib/manual";

describe("repair manual counts", () => {
  it("never recounts the archive when the page opens (too heavy): keeps the last number, or none", async () => {
    const env: any = { DB: testD1() };
    expect(await manual.pendingCounts(env)).toMatchObject({ new: 0, archive: null }); // never counted: no number
    env.DB.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('manual_pending', ?)").run(JSON.stringify({ new: 3, archive: 2872, at: 0 }));
    const spy = vi.spyOn(env.DB, "prepare");
    const r = await manual.pendingCounts(env); // stale: "new" is recounted, the archive isn't
    expect(r).toMatchObject({ archive: 2872 });
    expect(spy.mock.calls.some(([sql]) => /last_message_at < \?/.test(String(sql)))).toBe(false);
  });
});
