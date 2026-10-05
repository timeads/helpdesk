import { describe, expect, it } from "vitest";
import { testD1 } from "./helpers/d1";
import { addressKey, combineOrders, dismissMerge, dismissedMerges, mergeSuggestions } from "../src/lib/merge";

const addr = (over: Record<string, string | null> = {}) => ({
  name: "Jane Doe", address1: "12 Oak Street", address2: "Apt 3", city: "Philadelphia", provinceCode: "PA", zip: "19107-1234", countryCodeV2: "US", ...over,
}) as any;
const q = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id, name: `#${id}`, createdAt, shippingAddress: addr(), hasLabel: false, hold: null, pickup: false, paymentPending: false, itemCount: 1, ...over,
}) as any;

describe("shipping orders together", () => {
  it("matches the same person and address despite spelling differences", () => {
    expect(addressKey({ shippingAddress: addr() })).toBe(addressKey({ shippingAddress: addr({ name: "jane doe", address1: "12 Oak St.", address2: "#3", zip: "19107" }) }));
    expect(addressKey({ shippingAddress: addr() })).not.toBe(addressKey({ shippingAddress: addr({ address2: "Apt 4" }) }));
    expect(addressKey({ shippingAddress: addr() })).not.toBe(addressKey({ shippingAddress: addr({ name: "John Doe" }) }));
    expect(addressKey({ shippingAddress: null } as any)).toBeNull();
  });

  it("suggests 2+ shippable orders to one address, oldest first, and skips ones already handled", () => {
    const orders = [
      q("3", "2026-10-03", { itemCount: 2 }),
      q("1", "2026-10-01"),
      q("2", "2026-10-02", { shippingAddress: addr({ address1: "12 Oak St" }) }),
      q("4", "2026-10-04", { hasLabel: true }),
      q("5", "2026-10-04", { hold: "Waiting on yarn" }),
      q("6", "2026-10-04", { pickup: true }),
      q("7", "2026-10-04", { shippingAddress: addr({ name: "Bob", address1: "9 Elm Rd" }) }),
    ];
    const s = mergeSuggestions(orders, new Set());
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ orderIds: ["1", "2", "3"], names: ["#1", "#2", "#3"], customer: "Jane Doe", items: 4, address: "12 Oak Street, Apt 3, Philadelphia PA 19107-1234" });
    expect(mergeSuggestions(orders, new Set([s[0].key]))).toEqual([]);
    // A new order to the same address makes a new suggestion even after "Not now"
    expect(mergeSuggestions([...orders, q("8", "2026-10-05")], new Set([s[0].key]))).toHaveLength(1);
  });

  it("remembers dismissed suggestions", async () => {
    const env: any = { DB: testD1() };
    await dismissMerge(env, "k1");
    await dismissMerge(env, "k1");
    expect([...(await dismissedMerges(env))]).toEqual(["k1"]);
  });

  it("combines orders into one: the oldest order's details with every item and summed totals", () => {
    const money = (n: string) => ({ shopMoney: { amount: n, currencyCode: "USD" } });
    const o = (id: string, createdAt: string, title: string, total: string, ship: string) => ({
      id, name: `#${id}`, createdAt, lineItems: { nodes: [{ title, quantity: 1 }] }, totalPriceSet: money(total), totalShippingPriceSet: money(ship),
    }) as any;
    const c = combineOrders([o("2", "2026-10-02", "Yarn", "20", "5"), o("1", "2026-10-01", "The Duo", "299", "12.5")]);
    expect(c.id).toBe("1");
    expect(c.lineItems.nodes.map((l: any) => l.title)).toEqual(["The Duo", "Yarn"]);
    expect(c.totalPriceSet.shopMoney.amount).toBe("319");
    expect(c.totalShippingPriceSet!.shopMoney.amount).toBe("17.5");
  });
});
