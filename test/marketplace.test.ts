import { describe, expect, it } from "vitest";
import { marketplaceDeadlines } from "../src/lib/fulfillment";
import type { ShopifyOrder } from "../src/lib/shopify";

const order = (customAttributes: { key: string; value: string }[]) => ({ customAttributes }) as unknown as ShopifyOrder;

describe("marketplace deadlines", () => {
  it("reads Amazon's ship-by and deliver-by dates from Marketplace Connect's order attributes", () => {
    const d = marketplaceDeadlines(order([
      { key: "Amazon Order Id", value: "113-4300393-6159415" },
      { key: "Amazon Earliest Ship Date", value: "2026-10-07T07:00:00.000Z" },
      { key: "Amazon Earliest Delivery Date", value: "2026-10-15T07:00:00.000Z" },
      { key: "Amazon Latest Ship Date", value: "2026-10-08T06:59:59.000Z" },
      { key: "Amazon Latest Delivery Date", value: "2026-10-16T06:59:59.000Z" },
      { key: "Amazon Account", value: "Tuft the World LLC" },
    ]));
    expect(d).toEqual({ marketplace: "Amazon", marketplaceOrderId: "113-4300393-6159415", shipBy: "2026-10-08T06:59:59.000Z", deliverBy: "2026-10-16T06:59:59.000Z" });
  });

  it("is null for ordinary orders and tolerates bad dates", () => {
    expect(marketplaceDeadlines(order([]))).toBeNull();
    expect(marketplaceDeadlines({} as ShopifyOrder)).toBeNull();
    expect(marketplaceDeadlines(order([{ key: "Amazon Order Id", value: "1" }, { key: "Amazon Latest Ship Date", value: "soon" }]))?.shipBy).toBeNull();
  });
});
