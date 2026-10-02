import { describe, expect, it } from "vitest";
import { parseRates, splitCost } from "../src/lib/ups";

describe("per-box costs", () => {
  it("splits a total in proportion and always adds up", () => {
    expect(splitCost(30, [10, 20])).toEqual([10, 20]);
    const s = splitCost(10, [1, 1, 1])!;
    expect(s.reduce((n, x) => n + x, 0)).toBeCloseTo(10, 5);
    expect(splitCost(10, [5])).toBeUndefined();
    expect(splitCost(10, [5, NaN])).toBeUndefined();
  });
  it("reads UPS package charges and scales them to the negotiated total", () => {
    const [r] = parseRates({ RateResponse: { RatedShipment: {
      Service: { Code: "03" }, TotalCharges: { MonetaryValue: "40.00", CurrencyCode: "USD" },
      NegotiatedRateCharges: { TotalCharge: { MonetaryValue: "30.00" } },
      RatedPackage: [{ TotalCharges: { MonetaryValue: "25.00" } }, { TotalCharges: { MonetaryValue: "15.00" } }],
    } } });
    expect(r.total).toBe(30);
    expect(r.perBox).toEqual([18.75, 11.25]);
  });
  it("leaves single-box rates alone", () => {
    const [r] = parseRates({ RateResponse: { RatedShipment: { Service: { Code: "03" }, TotalCharges: { MonetaryValue: "12.00" }, RatedPackage: { TotalCharges: { MonetaryValue: "12.00" } } } } });
    expect(r.perBox).toBeUndefined();
  });
});
