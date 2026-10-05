import { describe, expect, it } from "vitest";
import { historyRow, shipStatus } from "../src/lib/history";
import { demoAllOrders } from "../src/lib/demo";

const f = (displayStatus: string, status = "SUCCESS", number = "1Z1") => ({ status, createdAt: "2026-10-01", displayStatus, trackingInfo: [{ company: "UPS", number, url: `https://ups/${number}` }] });

describe("order history", () => {
  it("words where each order is", () => {
    expect(shipStatus({ cancelledAt: "2026-10-01", displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] } as any).label).toBe("Cancelled");
    expect(shipStatus({ cancelledAt: null, displayFulfillmentStatus: "FULFILLED", fulfillments: [f("DELIVERED")] } as any)).toEqual({ key: "delivered", label: "Delivered" });
    expect(shipStatus({ cancelledAt: null, displayFulfillmentStatus: "FULFILLED", fulfillments: [f("DELIVERED"), f("IN_TRANSIT")] } as any)).toEqual({ key: "shipped", label: "In transit" });
    expect(shipStatus({ cancelledAt: null, displayFulfillmentStatus: "PARTIALLY_FULFILLED", fulfillments: [f("IN_TRANSIT")] } as any).label).toBe("Partly shipped");
    expect(shipStatus({ cancelledAt: null, displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] } as any)).toEqual({ key: "unshipped", label: "Not shipped" });
  });

  it("lists tracking once, leaves out cancelled shipments, and keeps the label bought here", () => {
    const shipped = demoAllOrders().find((o) => o.name === "#0988")!;
    const o = { ...shipped, fulfillments: [f("IN_TRANSIT"), f("IN_TRANSIT"), f("IN_TRANSIT", "CANCELLED", "OLD")] } as any;
    const label = { id: 3, carrier: "UPS", service: "UPS Ground", cost: 9.5, createdAt: "2026-10-01", by: "Tim", shippedWith: null };
    const r = historyRow(o, label);
    expect(r).toMatchObject({ name: "#0988", customer: "Jane Doe", place: "Austin, TX", items: 4, total: 64, payment: "Paid", status: { key: "shipped" }, label });
    expect(r.tracking).toEqual([{ company: "UPS", number: "1Z1", url: "https://ups/1Z1" }]);
    expect(r.shipments).toHaveLength(2);
    expect(r.lines).toEqual([{ title: "Acrylic Yarn Cone", variant: "Mustard", qty: 4, image: expect.any(String) }]);
  });
});
