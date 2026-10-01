// Shared fulfillment logic: what box/weight/service an order should get, and buying its label.
import type { Agent, Env } from "../env";
import type { ShopifyOrder } from "./shopify";
import { fulfillOrder } from "./shopify";
import { evaluateRules, type RuleResult, type ShippingRule } from "./rules";
import { createShipment, getRates, trackingUrl, type Address, type Parcel, type Rate, type Signature } from "./ups";
import { HttpError, getSetting } from "./util";

export interface Preset {
  id: number;
  name: string;
  type: string;
  length: number;
  width: number;
  height: number;
  weight: number; // tare, lb
  is_default: number;
}

export interface Plan {
  preset: Preset | null;
  parcel: Parcel;
  weightKnown: boolean;
  source: "rule" | "learned" | "default";
  signature: Signature;
  service: string | null;
  ruleHold: string | null;
  rules: RuleResult;
}

const WEIGHT_TO_LB: Record<string, number> = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 };
const round1 = (n: number) => Math.round(n * 10) / 10;

export const itemCount = (o: ShopifyOrder) => o.lineItems.nodes.reduce((n, l) => n + l.quantity, 0);
export const shippingPaid = (o: ShopifyOrder) => Number(o.totalShippingPriceSet?.shopMoney.amount ?? 0);
export const requestedService = (o: ShopifyOrder) => o.shippingLines.nodes[0]?.title ?? "";
export const isPriority = (o: ShopifyOrder) => /next|overnight|express|priority|2nd|second|2[- ]day|3 day|rush/i.test(requestedService(o));
export const isPaymentPending = (o: ShopifyOrder) => ["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "EXPIRED"].includes(o.displayFinancialStatus ?? "");
export const isInternational = (o: ShopifyOrder) => !!o.shippingAddress?.countryCodeV2 && o.shippingAddress.countryCodeV2 !== "US";

/** Identical item sets share a key, e.g. "AK5-CUT×1|YARN-MUSTARD×4". */
export function itemsKey(o: ShopifyOrder): string {
  return o.lineItems.nodes
    .map((l) => `${(l.sku || `${l.title}${l.variantTitle ? " / " + l.variantTitle : ""}`).toLowerCase()}×${l.quantity}`)
    .sort()
    .join("|");
}

/** Product weight from Shopify, or null when any line has no weight. */
export function itemsWeightLb(o: ShopifyOrder): number | null {
  let total = 0;
  for (const l of o.lineItems.nodes) {
    const w = l.variant?.inventoryItem?.measurement?.weight;
    if (!w || !(w.value > 0)) return null;
    total += w.value * (WEIGHT_TO_LB[w.unit] ?? 1) * l.quantity;
  }
  return total;
}

export async function loadPresets(env: Env): Promise<Preset[]> {
  const { results } = await env.DB.prepare("SELECT * FROM package_presets ORDER BY is_default DESC, name").all<Preset>();
  return results;
}

export async function loadRules(env: Env): Promise<ShippingRule[]> {
  const { results } = await env.DB.prepare("SELECT * FROM shipping_rules ORDER BY position, id").all<any>();
  return results.map((r) => ({ ...r, enabled: !!r.enabled, conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) }));
}

export async function loadLearned(env: Env, keys: string[]) {
  const map = new Map<string, { preset_id: number | null; length: number; width: number; height: number; weight: number }>();
  const unique = [...new Set(keys)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT * FROM learned_parcels WHERE item_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<any>();
    for (const r of results) map.set(r.item_key, r);
  }
  return map;
}

/** Box, weight, signature and service for each order: rule → learned from last time → default box. */
export async function planOrders(env: Env, orders: ShopifyOrder[]): Promise<Map<string, Plan>> {
  const [presets, rules, learning] = await Promise.all([loadPresets(env), loadRules(env), getSetting(env, "learning", { parcel: true, weight: true })]);
  const learned = await loadLearned(env, orders.map(itemsKey));
  const byName = new Map(presets.map((p) => [p.name.toLowerCase(), p]));
  const fallback = presets.find((p) => p.is_default) ?? presets[0] ?? null;
  const plans = new Map<string, Plan>();
  for (const o of orders) {
    const r = evaluateRules(o, rules);
    const items = itemsWeightLb(o);
    const memory = learned.get(itemsKey(o));
    let preset: Preset | null = null;
    let source: Plan["source"] = "default";
    let parcel: Parcel;
    if (r.packageName && byName.get(r.packageName.toLowerCase())) {
      preset = byName.get(r.packageName.toLowerCase())!;
      source = "rule";
    } else if (memory && learning.parcel) {
      preset = presets.find((p) => p.id === memory.preset_id) ?? null;
      source = "learned";
    } else preset = fallback;
    if (source === "learned" && memory) parcel = { length: memory.length, width: memory.width, height: memory.height, weight: 0 };
    else parcel = { length: preset?.length ?? 0, width: preset?.width ?? 0, height: preset?.height ?? 0, weight: 0 };
    let weightKnown = false;
    if (memory && learning.weight) {
      parcel.weight = memory.weight;
      weightKnown = true;
    } else if (items !== null) {
      parcel.weight = round1(items + (preset?.weight ?? 0));
      weightKnown = true;
    }
    plans.set(o.id, { preset, parcel, weightKnown, source, signature: r.signature, service: r.service, ruleHold: r.hold, rules: r });
  }
  return plans;
}

export function addressFromOrder(o: ShopifyOrder): Address {
  const a = (o.shippingAddress ?? {}) as Record<string, string | null>;
  return {
    name: a.name ?? "",
    company: a.company ?? "",
    phone: a.phone ?? o.phone ?? "",
    address1: a.address1 ?? "",
    address2: a.address2 ?? "",
    city: a.city ?? "",
    state: a.provinceCode ?? "",
    zip: a.zip ?? "",
    country: a.countryCodeV2 ?? "US",
    residential: !a.company,
  };
}

/** Pick a rate by policy: "cheapest", "fastest", or a UPS service code (falls back to cheapest). */
export function chooseRate(rates: Rate[], policy: string | null | undefined): Rate {
  if (!rates.length) throw new HttpError(422, "UPS returned no rates for this package");
  const byPrice = [...rates].sort((a, b) => a.total - b.total);
  if (policy === "fastest") {
    const timed = rates.filter((r) => r.days !== null).sort((a, b) => a.days! - b.days! || a.total - b.total);
    return timed[0] ?? byPrice[0];
  }
  if (policy && policy !== "cheapest") return rates.find((r) => r.serviceCode === policy) ?? byPrice[0];
  return byPrice[0];
}

export async function shipFrom(env: Env): Promise<Address> {
  const a = await getSetting<Address | null>(env, "ship_from", null);
  if (!a?.address1) throw new HttpError(409, "Add your ship-from address in Settings → Shipping first");
  if (!a.phone?.replace(/\D/g, "")) throw new HttpError(409, "Add a phone number to your ship-from address (Settings → Shipping) — UPS requires it");
  return a;
}

export interface BuyInput {
  order: ShopifyOrder | null;
  ticketId?: number | null;
  to: Address;
  parcels: Parcel[];
  presetId?: number | null;
  rate: { serviceCode: string; serviceName: string; listTotal?: number };
  signature: Signature;
  labelFormat: "GIF" | "ZPL";
  fulfill: boolean;
  notifyCustomer: boolean;
  batchId?: string | null;
  scanVerified?: boolean;
}

/** Buys the label, records it (with analytics fields), learns the box, and fulfills in Shopify. */
export async function buyLabel(env: Env, agent: Agent, input: BuyInput) {
  const o = input.order;
  const result = await createShipment(env, await shipFrom(env), input.to, input.parcels, input.rate.serviceCode, {
    reference: o?.name,
    labelFormat: input.labelFormat,
    signature: input.signature,
  });
  const row = await env.DB.prepare(
    `INSERT INTO shipments (order_id, order_name, ticket_id, service_code, service_name, shipment_id, tracking_numbers, labels, label_format,
       cost, currency, packages, ship_to, agent_id, signature, batch_id, shipping_paid, order_total, order_created_at, requested_service,
       list_cost, item_count, dest_state, dest_country, scan_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      o?.id ?? null, o?.name ?? null, input.ticketId ?? null, input.rate.serviceCode, input.rate.serviceName, result.shipmentId,
      JSON.stringify(result.trackingNumbers), JSON.stringify(result.labels), input.labelFormat, result.cost, result.currency,
      JSON.stringify(input.parcels), JSON.stringify(input.to), agent.id, input.signature ?? null, input.batchId ?? null,
      o ? shippingPaid(o) : null, o ? Number(o.totalPriceSet.shopMoney.amount) : null, o?.createdAt ?? null,
      o ? requestedService(o) : null, input.rate.listTotal ?? null, o ? itemCount(o) : null, input.to.state || null,
      input.to.country || null, input.scanVerified ? 1 : 0,
    )
    .first<{ id: number }>();

  // Remember this box + weight for the next identical set of items (single-package shipments)
  if (o && input.parcels.length === 1) {
    const p = input.parcels[0];
    await env.DB.prepare(
      `INSERT INTO learned_parcels (item_key, preset_id, length, width, height, weight, uses, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(item_key) DO UPDATE SET preset_id = excluded.preset_id, length = excluded.length, width = excluded.width,
         height = excluded.height, weight = excluded.weight, uses = uses + 1, updated_at = excluded.updated_at`,
    )
      .bind(itemsKey(o), input.presetId ?? null, p.length, p.width, p.height, p.weight)
      .run();
  }
  if (o) await env.DB.prepare("DELETE FROM order_holds WHERE order_id = ?").bind(o.id).run();

  let fulfillError: string | null = null;
  if (input.fulfill && o && result.trackingNumbers[0]) {
    try {
      await fulfillOrder(env, o.id, { company: "UPS", number: result.trackingNumbers[0], url: trackingUrl(result.trackingNumbers[0]) }, input.notifyCustomer);
      await env.DB.prepare("UPDATE shipments SET fulfilled = 1 WHERE id = ?").bind(row!.id).run();
    } catch (e) {
      fulfillError = (e as Error).message;
    }
  }
  return { id: row!.id, shipmentId: result.shipmentId, trackingNumbers: result.trackingNumbers, cost: result.cost, currency: result.currency, labelFormat: input.labelFormat, fulfillError };
}

export { getRates };
