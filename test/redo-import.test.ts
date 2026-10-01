import { describe, expect, it } from "vitest";
import { parseSelection, redoDate, summarize, trackingOwners, type RedoOrder } from "../src/lib/redo-import";

const box = (tracking: string, rate: number, paid: number, margin: number, extra: Partial<RedoOrder["boxes"][0]> = {}) => ({
  tracking, rate, paid, margin, status: "Delivered", shipped: "Sep 22, 2026", selection: `UPS® Ground - ${rate} - 4`, ...extra,
});

describe("Redo import", () => {
  it("counts the customer's shipping once and every box's label", () => {
    const o: RedoOrder = { order: "#68702-TG", customer: "A", orderDate: "Sep 21, 2026", boxes: [
      { ...box("", 36.37, 80, 43.63), selection: "", status: "", shipped: "" }, // no label
      box("1Z1", 25.53, 80, 54.47), box("1Z2", 36.37, 80, 43.63), box("1Z3", 36.37, 80, 43.63), box("1Z4", 36.37, 80, 43.63),
    ] };
    const s = summarize(o, undefined, trackingOwners([o]));
    expect(s.cost).toBe(134.64);
    expect(s.paid).toBe(80);
    expect(s.reported).toBe(185.36); // what Redo claimed
    expect(s.paid - s.cost).toBeCloseTo(-54.64);
  });
  it("uses Shopify's shipping paid (after refunds) when found", () => {
    const o: RedoOrder = { order: "#68569-TG", customer: "B", orderDate: "", boxes: [box("1Z5", 21.49, 130, 108.51), box("1Z6", 27.3, 130, 102.7)] };
    const s = summarize(o, { id: "gid", name: "#68569-TG", createdAt: "", paid: 60, orderTotal: 0, requested: null, state: null, country: null }, trackingOwners([o]));
    expect(s.paid).toBe(60);
    expect(s.notes[0]).toMatch(/Shopify shows \$60/);
  });
  it("skips cancelled labels and gives a shared tracking number to the order with a real service", () => {
    const a: RedoOrder = { order: "#68577-TG", customer: "", orderDate: "", boxes: [box("1ZX", 7.55, 14, 6.45, { selection: "UPS® - unknown - unknown", status: "" })] };
    const b: RedoOrder = { order: "#68575-TG", customer: "", orderDate: "", boxes: [box("1ZX", 7.9, 23, 15.1)] };
    const owners = trackingOwners([a, b]);
    expect(summarize(a, undefined, owners).cost).toBe(0);
    expect(summarize(b, undefined, owners).cost).toBe(7.9);
    const c: RedoOrder = { order: "#1", customer: "", orderDate: "", boxes: [box("1ZC", 26.96, 23, -3.96, { status: "Cancelled" })] };
    expect(summarize(c, undefined, trackingOwners([c])).voided).toBe(true);
  });
  it("reads services and dates", () => {
    expect(parseSelection("UPS 2nd Day Air® - 38.02 - 2")).toEqual({ carrier: "UPS", service: "UPS 2nd Day Air", code: "02" });
    expect(parseSelection("USPS Ground Advantage - 9.10 - 1").carrier).toBe("USPS");
    expect(redoDate("Oct 1, 2026")?.slice(0, 10)).toBe("2026-10-01");
  });
});
