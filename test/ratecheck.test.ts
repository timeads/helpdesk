import { describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const order = (id: string, country = "US") => ({
  id, name: `#${id}`, shippingAddress: { name: "Jane", address1: "1 Main", city: "Austin", provinceCode: "TX", zip: "78701", countryCodeV2: country },
  lineItems: { nodes: [{ id: `li${id}`, quantity: 1, title: "Rug", sku: "R1", variantTitle: null, variant: { inventoryItem: { measurement: { weight: { unit: "POUNDS", value: 4 } } } } }] },
});
vi.mock("../src/lib/shopify", () => ({ ordersByIds: vi.fn(async (_env: unknown, ids: string[]) => ids.filter((i) => i !== "gone").map((i) => order(i, i === "intl" ? "CA" : "US"))) }));
vi.mock("../src/lib/fulfillment", () => ({
  shipFrom: vi.fn(async () => ({ address1: "5400 Grays", city: "Philadelphia", state: "PA", zip: "19143", country: "US", phone: "2155550100" })),
  addressFromOrder: (o: any) => ({ address1: "1 Main", city: "Austin", state: "TX", zip: "78701", country: o.shippingAddress.countryCodeV2 }),
  isInternational: (o: any) => o.shippingAddress.countryCodeV2 !== "US",
  planOrders: vi.fn(async (_env: unknown, orders: any[]) => new Map(orders.map((o) => [o.id, {
    parcels: [{ length: 16, width: 12, height: 10, weight: 5 }], parcel: { length: 16, width: 12, height: 10, weight: 5 },
    preset: { name: "Medium" }, totalWeight: 5, weightKnown: true, source: "learned",
  }]))),
}));
vi.mock("../src/lib/carriers", () => ({
  getAllRates: vi.fn(async () => [
    { carrier: "UPS", serviceCode: "03", serviceName: "UPS Ground", total: 11.2, days: 3 },
    { carrier: "UPS", serviceCode: "ep:UPSDAP:Ground", serviceName: "UPS Ground · EasyPost", total: 9.6, days: 3 },
    { carrier: "USPS", serviceCode: "usps:GroundAdvantage", serviceName: "USPS Ground Advantage", total: 10.1, days: 4 },
  ]),
}));
import { checkNext, checkResults, compare, sameServiceRate } from "../src/lib/ratecheck";

function seed() {
  const db = testD1();
  const ins = db.raw.prepare("INSERT INTO shipments (order_id, order_name, service_code, service_name, cost, packages, source, source_ref, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'redo', ?, ?, ?)");
  const now = Date.now();
  const at = (d: number) => new Date(now - d * 86400_000).toISOString();
  ins.run("a", "#a", "03", "UPS Ground", 8.5, JSON.stringify([{ tracking: "1Z1", counted: true }]), "redo:a", at(1), "purchased");
  ins.run("b", "#b", "03", "UPS Ground", 12, "[]", "redo:b", at(2), "purchased");
  ins.run("gone", "#gone", "03", "UPS Ground", 9, "[]", "redo:gone", at(3), "purchased");
  ins.run("intl", "#intl", "", "UPS Standard", 30, "[]", "redo:intl", at(4), "purchased");
  ins.run("v", "#v", "03", "UPS Ground", 9, "[]", "redo:v", at(5), "voided");
  ins.run("old", "#old", "03", "UPS Ground", 9, "[]", "redo:old", at(200), "purchased");
  return { DB: db } as any;
}

describe("rate check", () => {
  it("finds the same service Redo used, preferring UPS direct", () => {
    const rates = [
      { carrier: "UPS", serviceCode: "ep:UPSDAP:Ground", serviceName: "UPS Ground · EasyPost", total: 9 },
      { carrier: "UPS", serviceCode: "03", serviceName: "UPS Ground", total: 10 },
    ] as any;
    expect(sameServiceRate(rates, "03", "UPS Ground")?.total).toBe(10);
    expect(sameServiceRate(rates, "", "UPS® Ground")?.total).toBe(10);
    const c = compare({ id: 1, order_id: "x", cost: 9.5, service_code: "03", service_name: "UPS Ground", packages: null }, rates);
    expect(c).toMatchObject({ best_total: 9, best_carrier: "UPS via EasyPost", same_total: 10 });
    expect(Object.keys(c.carriers)).toEqual(["UPS via EasyPost", "UPS"]);
  });

  it("re-quotes recent Redo shipments in batches and records why some are skipped", async () => {
    const env = seed();
    const first = await checkNext(env, { days: 90, limit: 100 });
    expect(first).toEqual({ total: 4, remaining: 1, checked: 3 });
    const second = await checkNext(env, { days: 90, limit: 100 });
    expect(second).toEqual({ total: 4, remaining: 0, checked: 1 });
    expect((await checkNext(env, { days: 90, limit: 100 })).checked).toBe(0);

    const rows = await checkResults(env);
    const by = Object.fromEntries(rows.map((r: any) => [r.order_name, r]));
    expect(by["#a"]).toMatchObject({ redo_cost: 8.5, best_total: 9.6, best_service: "UPS Ground · EasyPost", same_total: 11.2, box_name: "Medium", weight: 5, redo_boxes: 1, error: null });
    expect(by["#a"].carriers.USPS.total).toBe(10.1);
    expect(by["#gone"].error).toMatch(/not found/);
    expect(by["#intl"].error).toMatch(/International/);
    expect(by["#v"]).toBeUndefined();
    expect(by["#old"]).toBeUndefined();
  });
});
