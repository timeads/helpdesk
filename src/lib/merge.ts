// Shipping orders together: unshipped orders going to the same person at the same address can go in one
// box with one label. The queue suggests them; a teammate can also pick orders and ship them together.
import type { Env } from "../env";
import type { ShopifyOrder } from "./shopify";
import { getSetting, setSetting } from "./util";

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[.,#]/g, " ")
  .replace(/\b(street)\b/g, "st").replace(/\b(avenue)\b/g, "ave").replace(/\b(road)\b/g, "rd").replace(/\b(drive)\b/g, "dr").replace(/\b(boulevard)\b/g, "blvd")
  .replace(/\b(lane)\b/g, "ln").replace(/\b(apartment|apt|unit|suite|ste)\b/g, " ")
  .replace(/\s+/g, " ").trim();

/** Same person, same street address, same postcode and country → can share a box. Null without a shipping address. */
export function addressKey(o: Pick<ShopifyOrder, "shippingAddress">): string | null {
  const a = o.shippingAddress;
  if (!a?.address1) return null;
  const zip = String(a.zip ?? "").replace(/\s+/g, "").toUpperCase();
  return [norm(a.name), norm(a.address1), norm(a.address2), (a.countryCodeV2 ?? "US") === "US" ? zip.slice(0, 5) : zip, a.countryCodeV2 ?? ""].join("|");
}

export interface MergeSuggestion { key: string; orderIds: string[]; names: string[]; customer: string; address: string; items: number }

interface QueueOrder { id: string; name: string; createdAt: string; shippingAddress: ShopifyOrder["shippingAddress"]; hasLabel: boolean; hold: string | null; pickup: boolean; paymentPending: boolean; itemCount: number }

/** Groups of 2+ shippable orders to the same address (oldest first), minus ones a teammate dismissed. */
export function mergeSuggestions(orders: QueueOrder[], dismissed: Set<string>): MergeSuggestion[] {
  const groups = new Map<string, QueueOrder[]>();
  for (const o of orders) {
    if (o.hasLabel || o.hold || o.pickup || o.paymentPending) continue;
    const k = addressKey(o);
    if (k) groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  const out: MergeSuggestion[] = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const key = `${k}::${list.map((o) => o.id).sort().join(",")}`;
    if (dismissed.has(key)) continue;
    const a = list[0].shippingAddress!;
    out.push({
      key,
      orderIds: list.map((o) => o.id),
      names: list.map((o) => o.name),
      customer: a.name ?? "",
      address: [a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      items: list.reduce((n, o) => n + o.itemCount, 0),
    });
  }
  return out;
}

export const dismissedMerges = async (env: Env) => new Set(await getSetting<string[]>(env, "merge_dismissed", []));

export async function dismissMerge(env: Env, key: string) {
  const list = await getSetting<string[]>(env, "merge_dismissed", []);
  if (!list.includes(key)) await setSetting(env, "merge_dismissed", [...list, key].slice(-500));
}

/** One order holding every item of the group: the first (oldest) order's details with all the line items and totals. */
export function combineOrders(orders: ShopifyOrder[]): ShopifyOrder {
  const [first, ...rest] = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const sum = (pick: (o: ShopifyOrder) => { shopMoney: { amount: string; currencyCode: string } } | null | undefined) => {
    const cur = pick(first)?.shopMoney.currencyCode ?? "USD";
    return { shopMoney: { amount: String(orders.reduce((n, o) => n + Number(pick(o)?.shopMoney.amount ?? 0), 0)), currencyCode: cur } };
  };
  return {
    ...first,
    lineItems: { ...first.lineItems, nodes: [first, ...rest].flatMap((o) => o.lineItems.nodes) },
    totalPriceSet: sum((o) => o.totalPriceSet) as ShopifyOrder["totalPriceSet"],
    totalShippingPriceSet: sum((o) => o.totalShippingPriceSet) as ShopifyOrder["totalShippingPriceSet"],
  };
}
