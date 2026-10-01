// Macro variables ({{customer.first_name}}, {{order.tracking_url}} …), shared by the API and auto-replies.

export interface MacroContext {
  agent?: { name?: string | null } | null;
  customer?: { email?: string | null; name?: string | null } | null;
  order?: {
    name?: string | null;
    createdAt?: string | null;
    total?: string | null;
    fulfillmentStatus?: string | null;
    deliveryStatus?: string | null;
    shippedAt?: string | null;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    shippingAddress?: string | null;
  } | null;
  storeName?: string;
}

export const MACRO_VARIABLES: [string, string][] = [
  ["customer.first_name", "Customer first name"],
  ["customer.last_name", "Customer last name"],
  ["customer.full_name", "Customer full name"],
  ["customer.email", "Customer email"],
  ["agent.first_name", "Agent first name"],
  ["agent.full_name", "Agent full name"],
  ["order.number", "Recent order number"],
  ["order.date", "Recent order date"],
  ["order.price", "Recent order total"],
  ["order.fulfillment_status", "Recent order fulfillment status"],
  ["order.delivery_status", "Recent order delivery status"],
  ["order.shipping_date", "Recent order shipping date"],
  ["order.tracking_number", "Recent order tracking number"],
  ["order.tracking_url", "Recent order tracking URL"],
  ["order.shipping_address", "Recent order shipping address"],
  ["current_date", "Current date"],
  ["store.name", "Store name"],
];

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : "";
const human = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, " ") : "");

export function macroValues(ctx: MacroContext): Record<string, string> {
  const full = (ctx.customer?.name ?? "").trim();
  const [first, ...rest] = full.split(/\s+/);
  const agent = (ctx.agent?.name ?? "").trim();
  const o = ctx.order ?? {};
  return {
    "customer.first_name": first || "there",
    "customer.last_name": rest.join(" "),
    "customer.full_name": full,
    "customer.email": ctx.customer?.email ?? "",
    "agent.first_name": agent.split(/\s+/)[0] ?? "",
    "agent.full_name": agent,
    "agent.name": agent,
    "order.number": o.name ?? "",
    "order.date": fmtDate(o.createdAt),
    "order.price": o.total ?? "",
    "order.fulfillment_status": human(o.fulfillmentStatus),
    "order.delivery_status": human(o.deliveryStatus),
    "order.shipping_date": fmtDate(o.shippedAt),
    "order.tracking_number": o.trackingNumber ?? "",
    "order.tracking_url": o.trackingUrl ?? "",
    "order.shipping_address": o.shippingAddress ?? "",
    current_date: fmtDate(new Date().toISOString()),
    "store.name": ctx.storeName ?? "Tuft the World",
    // older short forms
    first_name: first || "there",
    agent_name: agent,
  };
}

/** Replaces {{variable}} placeholders; unknown variables are left as typed so nothing silently disappears. */
export function renderMacro(text: string, ctx: MacroContext): string {
  const v = macroValues(ctx);
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key: string) => (key in v ? v[key] : m));
}
