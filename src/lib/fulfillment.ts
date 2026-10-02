// Shared fulfillment logic: what box/weight/service an order should get, and buying its label.
import type { Agent, Env } from "../env";
import type { ShopifyOrder } from "./shopify";
import { fulfillOrder } from "./shopify";
import { evaluateRules, type RuleResult, type ShippingRule } from "./rules";
import { normalizePhone, splitCost, type Address, type Parcel, type Rate, type Signature } from "./ups";
import { getAllRates, purchase, trackingUrlFor } from "./carriers";
import { saveProfiles, type Customs } from "./customs";
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

export interface PlanBox {
  preset: Preset | null;
  parcel: Parcel;
  items: Record<string, number>; // line item id → quantity in this box
}

export interface Plan {
  preset: Preset | null;
  parcel: Parcel; // first box (kept for single-box callers)
  parcels: Parcel[]; // every box
  boxes: PlanBox[];
  totalWeight: number;
  weightKnown: boolean;
  source: "rule" | "learned" | "learned-similar" | "default" | "saved";
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

/** One product, however it's listed on the order: SKU, else title / variant. */
export const productKey = (l: { sku: string | null; title: string; variantTitle: string | null }) =>
  (l.sku || `${l.title}${l.variantTitle ? " / " + l.variantTitle : ""}`).toLowerCase();

/** Identical item sets share a key, e.g. "ak5-cut×1|yarn-mustard×4". */
export function itemsKey(o: ShopifyOrder): string {
  const qty = new Map<string, number>();
  for (const l of o.lineItems.nodes) qty.set(productKey(l), (qty.get(productKey(l)) ?? 0) + l.quantity);
  return [...qty].map(([k, q]) => `${k}×${q}`).sort().join("|");
}

/** The same products, ignoring quantities. */
export function productsKey(o: ShopifyOrder): string {
  return [...new Set(o.lineItems.nodes.map(productKey))].sort().join("|");
}

export function itemsLabel(o: ShopifyOrder): string {
  return o.lineItems.nodes.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(", ");
}

const lineWeightLb = (l: ShopifyOrder["lineItems"]["nodes"][0]): number | null => {
  const w = l.variant?.inventoryItem?.measurement?.weight;
  return w && w.value > 0 ? w.value * (WEIGHT_TO_LB[w.unit] ?? 1) : null;
};

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

export interface LearnedBox {
  preset_id: number | null;
  length: number;
  width: number;
  height: number;
  weight: number;
  items: Record<string, number>; // product key → quantity
}
export interface Learned {
  item_key: string;
  products_key: string | null;
  boxes: LearnedBox[];
}

/** Learned packings for exact item sets, plus the latest one for each product set (any quantities). */
export async function loadLearned(env: Env, orders: ShopifyOrder[]) {
  const exact = new Map<string, Learned>();
  const similar = new Map<string, Learned>();
  const rowToLearned = (r: any): Learned => ({
    item_key: r.item_key,
    products_key: r.products_key,
    boxes: r.boxes
      ? JSON.parse(r.boxes)
      : [{ preset_id: r.preset_id, length: r.length, width: r.width, height: r.height, weight: r.weight, items: Object.fromEntries(String(r.item_key).split("|").map((x: string) => { const i = x.lastIndexOf("×"); return [x.slice(0, i), Number(x.slice(i + 1))]; })) }],
  });
  const keys = [...new Set(orders.map(itemsKey))].filter(Boolean);
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const { results } = await env.DB.prepare(`SELECT * FROM learned_parcels WHERE item_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<any>();
    for (const r of results) exact.set(r.item_key, rowToLearned(r));
  }
  const pkeys = [...new Set(orders.filter((o) => !exact.has(itemsKey(o))).map(productsKey))].filter(Boolean);
  for (let i = 0; i < pkeys.length; i += 50) {
    const chunk = pkeys.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT * FROM learned_parcels WHERE products_key IN (${chunk.map(() => "?").join(",")}) ORDER BY updated_at`,
    ).bind(...chunk).all<any>();
    for (const r of results) similar.set(r.products_key, rowToLearned(r)); // latest wins
  }
  return { exact, similar };
}

/**
 * Boxes, weights, signature and service for each order:
 * rule → the packing used last time for these exact items (every box, what went in it)
 * → the box used for the same products in other quantities → the default box.
 */
export async function planOrders(env: Env, orders: ShopifyOrder[]): Promise<Map<string, Plan>> {
  const [presets, rules, learning] = await Promise.all([loadPresets(env), loadRules(env), getSetting(env, "learning", { parcel: true, weight: true })]);
  const { exact, similar } = await loadLearned(env, orders);
  const byName = new Map(presets.map((p) => [p.name.toLowerCase(), p]));
  const byId = new Map(presets.map((p) => [p.id, p]));
  const fallback = presets.find((p) => p.is_default) ?? presets[0] ?? null;
  const plans = new Map<string, Plan>();
  for (const o of orders) {
    const r = evaluateRules(o, rules);
    const items = itemsWeightLb(o);
    const allItems = Object.fromEntries(o.lineItems.nodes.map((l) => [l.id, l.quantity]));
    const dims = (p: Preset | null): Parcel => ({ length: p?.length ?? 0, width: p?.width ?? 0, height: p?.height ?? 0, weight: 0 });
    let boxes: PlanBox[];
    let source: Plan["source"] = "default";
    let weightKnown = false;
    const memory = learning.parcel ? exact.get(itemsKey(o)) : undefined;
    const near = learning.parcel && !memory ? similar.get(productsKey(o)) : undefined;

    if (r.packageName && byName.get(r.packageName.toLowerCase())) {
      const preset = byName.get(r.packageName.toLowerCase())!;
      boxes = [{ preset, parcel: dims(preset), items: allItems }];
      source = "rule";
    } else if (memory) {
      // Same items as before: same boxes, same split, same weights
      source = "learned";
      const lines = o.lineItems.nodes;
      const left = new Map(lines.map((l) => [l.id, l.quantity]));
      boxes = memory.boxes.map((b) => {
        const alloc: Record<string, number> = {};
        for (const [pk, q] of Object.entries(b.items ?? {})) {
          let need = q;
          for (const l of lines) {
            if (productKey(l) !== pk || need <= 0) continue;
            const take = Math.min(need, left.get(l.id) ?? 0);
            if (take > 0) { alloc[l.id] = (alloc[l.id] ?? 0) + take; left.set(l.id, (left.get(l.id) ?? 0) - take); need -= take; }
          }
        }
        return { preset: b.preset_id ? byId.get(b.preset_id) ?? null : null, parcel: { length: b.length, width: b.width, height: b.height, weight: learning.weight ? b.weight : 0 }, items: alloc };
      });
      // Anything not placed (shouldn't happen for an exact match) goes in the first box
      for (const [id, q] of left) if (q > 0) boxes[0].items[id] = (boxes[0].items[id] ?? 0) + q;
      weightKnown = learning.weight && boxes.every((b) => b.parcel.weight > 0);
    } else if (near && near.boxes.length === 1) {
      // Same products in other quantities: reuse that box; weight comes from product weights
      source = "learned-similar";
      const b = near.boxes[0];
      const preset = b.preset_id ? byId.get(b.preset_id) ?? null : null;
      boxes = [{ preset, parcel: { length: b.length, width: b.width, height: b.height, weight: 0 }, items: allItems }];
    } else {
      boxes = [{ preset: fallback, parcel: dims(fallback), items: allItems }];
    }

    // Fill in weights from Shopify product weights where memory didn't give one
    if (!weightKnown) {
      const lw = new Map(o.lineItems.nodes.map((l) => [l.id, lineWeightLb(l)]));
      const computable = items !== null;
      if (computable) {
        for (const b of boxes) {
          const w = Object.entries(b.items).reduce((n, [id, q]) => n + (lw.get(id) ?? 0) * q, 0);
          b.parcel.weight = round1(Math.max(0.1, w + (b.preset?.weight ?? 0)));
        }
        weightKnown = true;
      }
    }
    const parcels = boxes.map((b) => b.parcel);
    plans.set(o.id, {
      preset: boxes[0].preset,
      parcel: parcels[0],
      parcels,
      boxes,
      totalWeight: round1(parcels.reduce((n, p) => n + p.weight, 0)),
      weightKnown,
      source,
      signature: r.signature,
      service: r.service,
      ruleHold: r.hold,
      rules: r,
    });
  }
  return plans;
}

/** Remembers how an order was packed: every box, its size and weight, and what went in it. */
export async function learnPacking(env: Env, o: ShopifyOrder, parcels: Parcel[], fallbackPresetId: number | null) {
  const lines = new Map(o.lineItems.nodes.map((l) => [l.id, l]));
  const boxes: LearnedBox[] = parcels.map((p, i) => {
    const items: Record<string, number> = {};
    if (parcels.length === 1 || !p.contents?.length) {
      if (parcels.length === 1) for (const l of o.lineItems.nodes) items[productKey(l)] = (items[productKey(l)] ?? 0) + l.quantity;
    } else {
      for (const c of p.contents) {
        const l = lines.get(c.id);
        if (l) items[productKey(l)] = (items[productKey(l)] ?? 0) + c.qty;
      }
    }
    return {
      preset_id: p.presetId ?? (i === 0 && parcels.length === 1 ? fallbackPresetId : null),
      length: p.length,
      width: p.width,
      height: p.height,
      weight: p.weight,
      items,
    };
  });
  const first = boxes[0];
  await env.DB.prepare(
    `INSERT INTO learned_parcels (item_key, preset_id, length, width, height, weight, uses, updated_at, boxes, products_key, label)
     VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)
     ON CONFLICT(item_key) DO UPDATE SET preset_id = excluded.preset_id, length = excluded.length, width = excluded.width,
       height = excluded.height, weight = excluded.weight, uses = uses + 1, updated_at = excluded.updated_at,
       boxes = excluded.boxes, products_key = excluded.products_key, label = excluded.label`,
  )
    .bind(itemsKey(o), first.preset_id, first.length, first.width, first.height, first.weight, JSON.stringify(boxes), productsKey(o), itemsLabel(o).slice(0, 500))
    .run();
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
  if (!rates.length) throw new HttpError(422, "No carrier returned a rate for this package");
  const byPrice = [...rates].sort((a, b) => a.total - b.total);
  if (policy === "fastest") {
    const timed = rates.filter((r) => r.days !== null).sort((a, b) => a.days! - b.days! || a.total - b.total);
    return timed[0] ?? byPrice[0];
  }
  if (policy && policy !== "cheapest") return rates.find((r) => r.serviceCode === policy) ?? byPrice[0];
  return byPrice[0];
}

/** The UI recognizes this message and offers to add the number right there. */
export const SHIP_FROM_PHONE = "Your ship-from (return) address needs a phone number — carriers print it on every label. This is your number, not the customer's.";

export async function shipFrom(env: Env): Promise<Address> {
  const a = await getSetting<Address | null>(env, "ship_from", null);
  if (!a?.address1) throw new HttpError(409, "Add your ship-from address in Settings → Shipping first");
  if (normalizePhone(a.phone, a.country).length < 10) throw new HttpError(409, SHIP_FROM_PHONE);
  return a;
}

export interface BuyInput {
  order: ShopifyOrder | null;
  ticketId?: number | null;
  to: Address;
  parcels: Parcel[];
  presetId?: number | null;
  rate: { serviceCode: string; serviceName: string; listTotal?: number; perBox?: number[] };
  signature: Signature;
  labelFormat: "GIF" | "ZPL";
  fulfill: boolean;
  notifyCustomer: boolean;
  batchId?: string | null;
  scanVerified?: boolean;
  customs?: Customs;
}

/** Buys the label, records it (with analytics fields), learns the box, and fulfills in Shopify. */
export async function buyLabel(env: Env, agent: Agent, input: BuyInput) {
  const o = input.order;
  const result = await purchase(env, await shipFrom(env), input.to, input.parcels, input.rate.serviceCode, {
    reference: o?.name,
    labelFormat: input.labelFormat,
    signature: input.signature,
    customs: input.customs,
  });
  // Each box's cost: from the carrier when it says, else the quote's split scaled to what was charged
  const perBox = input.parcels.length > 1
    ? result.perBox ?? (input.rate.perBox?.length === input.parcels.length ? splitCost(result.cost, input.rate.perBox) : undefined)
    : undefined;
  const row = await env.DB.prepare(
    `INSERT INTO shipments (forms, carrier, order_id, order_name, ticket_id, service_code, service_name, shipment_id, tracking_numbers, labels, label_format,
       cost, currency, packages, ship_to, agent_id, signature, batch_id, shipping_paid, order_total, order_created_at, requested_service,
       list_cost, item_count, dest_state, dest_country, scan_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      JSON.stringify(result.forms ?? []),
      result.carrier,
      o?.id ?? null, o?.name ?? null, input.ticketId ?? null, input.rate.serviceCode, input.rate.serviceName, result.shipmentId,
      JSON.stringify(result.trackingNumbers), JSON.stringify(result.labels), result.format, result.cost, result.currency,
      JSON.stringify(input.parcels.map((p, i) => (perBox ? { ...p, cost: perBox[i] } : p))), JSON.stringify(input.to), agent.id, input.signature ?? null, input.batchId ?? null,
      o ? shippingPaid(o) : null, o ? Number(o.totalPriceSet.shopMoney.amount) : null, o?.createdAt ?? null,
      o ? requestedService(o) : null, input.rate.listTotal ?? null, o ? itemCount(o) : null, input.to.state || null,
      input.to.country || null, input.scanVerified ? 1 : 0,
    )
    .first<{ id: number }>();

  // Remember how this was packed for the next order with the same items (single or multi-box)
  if (o) await learnPacking(env, o, input.parcels, input.presetId ?? null).catch((e) => console.error("learn packing", e));
  if (input.customs) await saveProfiles(env, input.customs).catch((e) => console.error("customs profiles", e));
  if (o) await env.DB.prepare("DELETE FROM order_holds WHERE order_id = ?").bind(o.id).run();

  let fulfillError: string | null = null;
  if (input.fulfill && o && result.trackingNumbers[0]) {
    try {
      // Every box's tracking number goes on the one fulfillment, so the customer's email lists them all
      const numbers = result.trackingNumbers;
      await fulfillOrder(env, o.id, { company: result.carrier, numbers, urls: numbers.map((n) => trackingUrlFor(result.carrier, n)) }, input.notifyCustomer);
      await env.DB.prepare("UPDATE shipments SET fulfilled = 1 WHERE id = ?").bind(row!.id).run();
    } catch (e) {
      fulfillError = (e as Error).message;
    }
  }
  if (o) await env.DB.prepare("DELETE FROM order_drafts WHERE order_id = ?").bind(o.id).run(); // the label is bought; choices are done
  return { perBox: perBox ?? null, id: row!.id, shipmentId: result.shipmentId, trackingNumbers: result.trackingNumbers, cost: result.cost, currency: result.currency, labelFormat: result.format, carrier: result.carrier, forms: (result.forms ?? []).length, fulfillError };
}

export { getAllRates as getRates };
