import { describe, it, expect } from "vitest";
import { stateForZip } from "../src/lib/zip-state";

describe("stateForZip", () => {
  it("finds the state from the first three digits", () => {
    expect(stateForZip("19103")).toBe("PA");
    expect(stateForZip("10001")).toBe("NY");
    expect(stateForZip("90001")).toBe("CA");
    expect(stateForZip("73301")).toBe("TX");
    expect(stateForZip("20500")).toBe("DC");
    expect(stateForZip("99501-1234")).toBe("AK");
  });
  it("rejects what isn't a US ZIP", () => {
    expect(stateForZip("1910")).toBeNull();
    expect(stateForZip("M5V 2T6")).toBeNull();
    expect(stateForZip("00100")).toBeNull();
  });
});
