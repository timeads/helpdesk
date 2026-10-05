// Order history: every order, shipped or not, summed up for one row of the Shipping → All orders list.
import type { ShopifyOrder } from "./shopify";

export const HISTORY_FILTERS: Record<string, string> = {
  all: "",
  to_ship: "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)",
  shipped: "fulfillment_status:shipped",
  cancelled: "status:cancelled",
};

export interface LabelInfo { id: number; carrier: string; service: string; cost: number | null; createdAt: string; by: string | null; shippedWith: string | null }

const human = (s: string | null | undefined) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");

/** Where the order is: cancelled, delivered, shipped, partly shipped or not shipped yet. */
export function shipStatus(o: Pick<ShopifyOrder, "cancelledAt" | "displayFulfillmentStatus" | "fulfillments">): { key: string; label: string } {
  if (o.cancelledAt) return { key: "cancelled", label: "Cancelled" };
  const f = (o.fulfillments ?? []).filter((x) => x.status !== "CANCELLED");
  if (o.displayFulfillmentStatus === "FULFILLED") {
    if (f.length && f.every((x) => x.displayStatus === "DELIVERED")) return { key: "delivered", label: "Delivered" };
    if (f.some((x) => x.displayStatus === "OUT_FOR_DELIVERY")) return { key: "shipped", label: "Out for delivery" };
    return { key: "shipped", label: f.some((x) => x.displayStatus === "IN_TRANSIT") ? "In transit" : "Shipped" };
  }
  if (o.displayFulfillmentStatus === "PARTIALLY_FULFILLED") return { key: "partial", label: "Partly shipped" };
  return { key: "unshipped", label: o.displayFulfillmentStatus === "ON_HOLD" ? "On hold" : "Not shipped" };
}

/** One row: who, what, how much, where it is, and its tracking (from Shopify) plus the label bought here, if any. */
export function historyRow(o: ShopifyOrder, label: LabelInfo | null) {
  const a = o.shippingAddress;
  const tracking = (o.fulfillments ?? []).filter((f) => f.status !== "CANCELLED").flatMap((f) => f.trackingInfo ?? []).filter((t) => t.number);
  const seen = new Set<string>();
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    customer: a?.name || o.email || "",
    email: o.email,
    place: a ? [a.city, a.provinceCode || a.countryCodeV2].filter(Boolean).join(", ") : "",
    items: o.lineItems.nodes.reduce((n, l) => n + l.quantity, 0),
    total: Number(o.totalPriceSet?.shopMoney.amount ?? 0),
    currency: o.totalPriceSet?.shopMoney.currencyCode ?? "USD",
    payment: human(o.displayFinancialStatus),
    status: shipStatus(o),
    tracking: tracking.filter((t) => !seen.has(t.number!) && seen.add(t.number!)).map((t) => ({ company: t.company, number: t.number, url: t.url })),
    label,
    lines: o.lineItems.nodes.map((l) => ({ title: l.title, variant: l.variantTitle, qty: l.quantity, image: l.image?.url ?? null })),
    shipments: (o.fulfillments ?? []).filter((f) => f.status !== "CANCELLED").map((f) => ({
      at: f.createdAt, status: human(f.displayStatus), tracking: (f.trackingInfo ?? []).filter((t) => t.number).map((t) => ({ company: t.company, number: t.number, url: t.url })),
    })),
    adminUrl: o.adminUrl ?? null,
  };
}
