import { afterEach, describe, expect, it, vi } from "vitest";
import { fulfillOrder, remaining, type ShopifyOrder } from "../src/lib/shopify";
import { leftBehind } from "../src/lib/fulfillment";

const order = (lines: { id: string; title: string; quantity: number; unfulfilledQuantity?: number }[]) =>
  ({ id: "gid://shopify/Order/1", name: "#1001", lineItems: { nodes: lines.map((l) => ({ variantTitle: null, sku: null, image: null, ...l })) } }) as unknown as ShopifyOrder;

describe("partial shipments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only what's left to ship counts once part of the order has shipped", () => {
    const o = remaining(order([
      { id: "a", title: "Gun", quantity: 1, unfulfilledQuantity: 0 },
      { id: "b", title: "Cloth", quantity: 3, unfulfilledQuantity: 2 },
    ]));
    expect(o.lineItems.nodes.map((l) => [l.id, l.quantity])).toEqual([["b", 2]]);
  });

  it("describes what a partial shipment leaves behind", () => {
    const o = order([{ id: "a", title: "Gun", quantity: 1 }, { id: "b", title: "Cloth", quantity: 3 }]);
    expect(leftBehind(o, [{ id: "a", qty: 1 }, { id: "b", qty: 1 }])).toBe("2 × Cloth");
  });

  it("tells Shopify to fulfill only the shipped quantities, across fulfillment orders", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.query.includes("fulfillmentOrders")) {
        return new Response(JSON.stringify({ data: { order: { fulfillmentOrders: { nodes: [
          { id: "fo1", status: "OPEN", lineItems: { nodes: [{ id: "foA", remainingQuantity: 1, lineItem: { id: "a" } }, { id: "foB1", remainingQuantity: 1, lineItem: { id: "b" } }] } },
          { id: "fo2", status: "OPEN", lineItems: { nodes: [{ id: "foB2", remainingQuantity: 2, lineItem: { id: "b" } }] } },
        ] } } } }));
      }
      return new Response(JSON.stringify({ data: { fulfillmentCreate: { fulfillment: { id: "f1" }, userErrors: [] } } }));
    }));
    const env = { SHOPIFY_SHOP: "x.myshopify.com", SHOPIFY_API_VERSION: "2026-07", SHOPIFY_ADMIN_TOKEN: "t" } as any;
    await fulfillOrder(env, "gid://shopify/Order/1", { company: "UPS", numbers: ["1Z1"], urls: ["u"] }, true, [{ id: "a", qty: 1 }, { id: "b", qty: 2 }]);
    const sent = calls[1].variables.f.lineItemsByFulfillmentOrder;
    expect(sent).toEqual([
      { fulfillmentOrderId: "fo1", fulfillmentOrderLineItems: [{ id: "foA", quantity: 1 }, { id: "foB1", quantity: 1 }] },
      { fulfillmentOrderId: "fo2", fulfillmentOrderLineItems: [{ id: "foB2", quantity: 1 }] },
    ]);
  });
});
