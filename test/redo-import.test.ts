import { describe, expect, it } from "vitest";
import { testD1 } from "./helpers/d1";
import { importRedoOrders, parseSelection, redoDate, summarize, trackingOwners, type RedoOrder } from "../src/lib/redo-import";

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

describe("Redo import alongside labels bought in the helpdesk", () => {
  it("leaves out labels the helpdesk already bought (and recorded), imports the ones bought on Redo's site", async () => {
    const db = testD1();
    db.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
    db.raw.prepare("INSERT INTO shipments (order_name, carrier, service_code, service_name, tracking_numbers, labels, label_format, cost, currency, packages, ship_to, status, agent_id) VALUES ('#2001', 'UPS', 'redo:1:ca:UPS:Ground', 'UPS Ground · Redo', '[\"1ZAPP\"]', '[]', 'PDF', 25.53, 'USD', '[]', '{}', 'purchased', 1)").run();
    const env: any = { DB: db };
    const orders: RedoOrder[] = [
      { order: "#2001", customer: "A", orderDate: "Oct 10, 2026", boxes: [box("1ZAPP", 25.53, 20, -5.53)] },
      { order: "#1990", customer: "B", orderDate: "Oct 1, 2026", boxes: [box("1ZSITE", 12.4, 15, 2.6)] },
    ];
    const r = await importRedoOrders(env, orders, 1);
    expect(r.skipped).toBe(1);
    const imported = db.raw.prepare("SELECT order_name, cost FROM shipments WHERE source = 'redo'").all();
    expect(imported).toEqual([{ order_name: "#1990", cost: 12.4 }]);
  });
});
