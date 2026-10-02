import { describe, expect, it } from "vitest";
import { normalizePhone } from "../src/lib/ups";

describe("normalizePhone", () => {
  it("drops the +1 country code on US and Canadian numbers", () => {
    expect(normalizePhone("+18132158641", "US")).toBe("8132158641");
    expect(normalizePhone("1 (813) 215-8641", "US")).toBe("8132158641");
    expect(normalizePhone("+1 416-555-0199", "CA")).toBe("4165550199");
  });
  it("keeps 10-digit numbers and strips punctuation", () => {
    expect(normalizePhone("(813) 215-8641", "US")).toBe("8132158641");
    expect(normalizePhone("813.215.8641", undefined)).toBe("8132158641");
  });
  it("cuts off extensions", () => {
    expect(normalizePhone("813-215-8641 ext. 22", "US")).toBe("8132158641");
    expect(normalizePhone("813-215-8641 x22", "US")).toBe("8132158641");
  });
  it("keeps the country code abroad, without + or 00", () => {
    expect(normalizePhone("+44 20 7946 0958", "GB")).toBe("442079460958");
    expect(normalizePhone("0044 20 7946 0958", "GB")).toBe("442079460958");
  });
  it("handles empty values", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone("")).toBe("");
  });
});
