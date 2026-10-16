import { describe, it, expect } from "vitest";
import { monthStartNY } from "../src/routes/analytics";

describe("monthStartNY", () => {
  it("is midnight Eastern on the 1st, daylight or standard time", () => {
    expect(new Date(monthStartNY(2026, 10)).toISOString()).toBe("2026-10-01T04:00:00.000Z"); // EDT
    expect(new Date(monthStartNY(2026, 12)).toISOString()).toBe("2026-12-01T05:00:00.000Z"); // EST
    expect(new Date(monthStartNY(2027, 1)).toISOString()).toBe("2027-01-01T05:00:00.000Z");
  });
});
