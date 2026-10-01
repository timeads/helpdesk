// Synthetic Shopify data for local previews only (DEMO_DATA=1 and Shopify not connected). Never real customers.
import type { ShopifyOrder } from "./shopify";

const img = (label: string, bg: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${bg}"/></svg>`)}`;

const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "USD" } });
const address = (name: string, city: string, state: string, zip: string) => ({
  name, company: null, address1: "100 Example St", address2: null, city, province: state, provinceCode: state, zip, country: "United States", countryCodeV2: "US", phone: null,
});
const line = (title: string, variant: string | null, qty: number, price: string, label: string, bg: string, lb: number) => ({
  id: `gid://shopify/LineItem/${title.length}${qty}`, title, variantTitle: variant, quantity: qty, sku: null,
  originalUnitPriceSet: money(price), image: { url: img(label, bg) },
  variant: { inventoryItem: { measurement: { weight: { value: lb, unit: "POUNDS" } } } },
});

function order(id: number, name: string, daysAgo: number, total: string, fin: string, ful: string, lines: any[], to: any, tracking?: string, shipping = "UPS Ground"): ShopifyOrder {
  return {
    id: `gid://shopify/Order/${id}`, name, createdAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
    cancelledAt: null, closed: false, note: null, email: null, phone: null,
    displayFinancialStatus: fin, displayFulfillmentStatus: ful, totalPriceSet: money(total),
    shippingAddress: to, shippingLines: { nodes: [{ title: shipping }] }, lineItems: { nodes: lines },
    fulfillments: tracking ? [{ status: "SUCCESS", createdAt: new Date().toISOString(), displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: tracking, url: `https://www.ups.com/track?tracknum=${tracking}` }] }] : [],
    adminUrl: "#demo",
  };
}

// Built per request: in Workers, Date.now() is frozen at 0 during module initialisation.
const people = (): Record<string, { name: string; since: string; tags: string[]; orders: ShopifyOrder[] }> => ({
  "jane.doe@example.com": {
    name: "Jane Doe", since: "2024-03-02", tags: ["workshop alum"],
    orders: [
      order(9042, "#1042", 6, "289.00", "PAID", "UNFULFILLED", [line("AK-I Cut Pile Tufting Gun", null, 1, "239.00", "AK-I", "#213838", 4.5), line("Primary Tufting Cloth", "2m width", 2, "25.00", "CLOTH", "#b4b098", 1)], address("Jane Doe", "Austin", "TX", "78701")),
      order(8811, "#0988", 210, "64.00", "PAID", "FULFILLED", [line("Acrylic Yarn Cone", "Mustard", 4, "16.00", "YARN", "#c78c2b", 0.6)], address("Jane Doe", "Austin", "TX", "78701"), "1Z999AA10123456784"),
    ],
  },
  "marcus@example.com": {
    name: "Marcus Lee", since: "2025-06-11", tags: [],
    orders: [order(9031, "#1031", 3, "64.00", "PAID", "FULFILLED", [line("Acrylic Yarn Cone", "Goldenrod", 4, "16.00", "YARN", "#b03424", 0.6)], address("Marcus Lee", "Denver", "CO", "80202"), "1Z999AA10123456785")],
  },
});

export function demoProfile(email: string) {
  const p = people()[email.toLowerCase()];
  if (!p) return { customer: null, orders: [], demo: true };
  const spent = p.orders.reduce((n, o) => n + Number(o.totalPriceSet.shopMoney.amount), 0);
  return {
    demo: true,
    customer: {
      id: "gid://shopify/Customer/1", displayName: p.name, email, phone: null, note: null, tags: p.tags,
      createdAt: p.since, numberOfOrders: String(p.orders.length), amountSpent: { amount: spent.toFixed(2), currencyCode: "USD" },
      defaultAddress: null, adminUrl: "#demo",
    },
    orders: p.orders,
  };
}

export function demoOrders(): ShopifyOrder[] {
  return Object.values(people()).flatMap((p) => p.orders).filter((o) => o.displayFulfillmentStatus === "UNFULFILLED");
}
