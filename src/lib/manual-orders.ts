import type { Env } from "../env";
import type { ShopifyOrder } from "./shopify";
import type { Address } from "./ups";
import { HttpError } from "./util";

/**
 * Orders made on the blank-label page with "Save as order": no Shopify order behind them, just an
 * address and the box/service choices (kept as the order's draft). They wait in To ship until
 * their label is bought, so a label can be set up on one computer and printed at another.
 */
export const MANUAL_PREFIX = "manual:";
export const isManualId = (id: string | null | undefined) => !!id && id.startsWith(MANUAL_PREFIX);
export const manualName = (n: number) => `L-${n}`;

interface Row { id: number; note: string; ship_to: string; status: string; created_at: string }

export function manualToOrder(r: Row): ShopifyOrder & { manual: true; manualNote: string } {
  let a: Partial<Address> = {};
  try { a = JSON.parse(r.ship_to) ?? {}; } catch { /* keep empty */ }
  const zero = { shopMoney: { amount: "0.00", currencyCode: "USD" } };
  return {
    id: `${MANUAL_PREFIX}${r.id}`, name: manualName(r.id), createdAt: r.created_at, cancelledAt: null, closed: false,
    note: r.note || null, email: null, phone: a.phone || null, tags: [],
    displayFinancialStatus: "PAID", displayFulfillmentStatus: r.status === "shipped" ? "FULFILLED" : "UNFULFILLED",
    totalPriceSet: zero, subtotalPriceSet: zero, totalDiscountsSet: zero, totalTaxSet: zero,
    shippingAddress: {
      name: a.name ?? "", company: a.company || null, address1: a.address1 ?? "", address2: a.address2 || null, city: a.city ?? "",
      province: a.state ?? "", provinceCode: a.state ?? "", zip: a.zip ?? "", country: a.country ?? "US", countryCodeV2: a.country ?? "US", phone: a.phone || null,
    },
    shippingLines: { nodes: [] }, lineItems: { nodes: [] }, fulfillments: [],
    manual: true, manualNote: r.note,
  };
}

export async function openManualOrders(env: Env) {
  const { results } = await env.DB.prepare("SELECT id, note, ship_to, status, created_at FROM manual_orders WHERE status = 'open' ORDER BY id").all<Row>();
  return results.map(manualToOrder);
}

export async function getManualOrder(env: Env, id: string) {
  const n = Number(id.slice(MANUAL_PREFIX.length));
  const r = Number.isInteger(n) && n > 0
    ? await env.DB.prepare("SELECT id, note, ship_to, status, created_at FROM manual_orders WHERE id = ? AND status != 'deleted'").bind(n).first<Row>()
    : null;
  if (!r) throw new HttpError(404, "That saved label order is gone");
  return manualToOrder(r);
}

export async function createManualOrder(env: Env, agentId: number, to: Address, note: string) {
  const r = await env.DB.prepare("INSERT INTO manual_orders (note, ship_to, agent_id) VALUES (?, ?, ?) RETURNING id, note, ship_to, status, created_at")
    .bind(note.slice(0, 500), JSON.stringify(to), agentId).first<Row>();
  return manualToOrder(r!);
}

export async function setManualStatus(env: Env, id: string, status: "open" | "shipped" | "deleted") {
  if (!isManualId(id)) return;
  await env.DB.prepare("UPDATE manual_orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .bind(status, Number(id.slice(MANUAL_PREFIX.length))).run();
}
