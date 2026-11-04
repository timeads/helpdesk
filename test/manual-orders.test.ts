import { describe, it, expect } from "vitest";
import { isManualId, manualToOrder } from "../src/lib/manual-orders";
import { addressFromOrder } from "../src/lib/fulfillment";

describe("saved label orders", () => {
  const to = { name: "Pat Example", company: "", phone: "2155550100", address1: "350 5th Ave", address2: "", city: "New York", state: "NY", zip: "10118", country: "US" };
  const o = manualToOrder({ id: 7, note: "Workshop kit", ship_to: JSON.stringify(to), status: "open", created_at: "2026-11-04T12:00:00.000Z" });

  it("looks like an order with no items, named L-n", () => {
    expect(o.id).toBe("manual:7");
    expect(isManualId(o.id)).toBe(true);
    expect(isManualId("gid://shopify/Order/1")).toBe(false);
    expect(o.name).toBe("L-7");
    expect(o.lineItems.nodes).toEqual([]);
    expect(o.manualNote).toBe("Workshop kit");
  });

  it("keeps the ship-to address", () => {
    const a = addressFromOrder(o);
    expect([a.name, a.address1, a.city, a.state, a.zip, a.country]).toEqual(["Pat Example", "350 5th Ave", "New York", "NY", "10118", "US"]);
  });
});
