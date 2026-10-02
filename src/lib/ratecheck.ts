// Rate check: re-quotes shipments that went out through Redo with our own accounts (UPS direct
// and every EasyPost carrier), to show where Redo's rates beat ours and by how much. The boxes and
// weights are the ones we'd use today (box memory, rules, product weights); the rates are today's.
import type { Env } from "../env";
import { getAllRates } from "./carriers";
import { addressFromOrder, isInternational, planOrders, shipFrom } from "./fulfillment";
import { ordersByIds, type ShopifyOrder } from "./shopify";
import type { Rate } from "./ups";

export interface RedoShipment {
  id: number;
  order_id: string;
  cost: number;
  service_code: string | null;
  service_name: string | null;
  packages: string | null;
}

export interface CheckRow {
  boxes: number | null;
  weight: number | null;
  box_name: string | null;
  weight_source: string | null;
  redo_cost: number;
  redo_service: string | null;
  redo_boxes: number;
  best_total: number | null;
  best_service: string | null;
  best_carrier: string | null;
  same_total: number | null;
  same_service: string | null;
  carriers: Record<string, { total: number; service: string }>;
  error: string | null;
}

const BATCH = 3;
const norm = (s: string) => s.toLowerCase().replace(/[®™]/g, "").replace(/\s+·\s+easypost$/, "").replace(/\s+/g, " ").trim();
/** UPS bought through EasyPost is listed apart from UPS direct: they're different prices. */
export const carrierKey = (r: Rate) => (r.carrier === "UPS" && /^(ep|usps):/.test(r.serviceCode) ? "UPS via EasyPost" : r.carrier ?? "UPS");

function redoBoxes(packages: string | null): number {
  try {
    const p = JSON.parse(packages ?? "[]");
    return Array.isArray(p) && p.length ? p.filter((b: any) => b.counted !== false).length || p.length : 1;
  } catch {
    return 1;
  }
}

/** The rate for the same service Redo used: UPS by service code, others by name. */
export function sameServiceRate(rates: Rate[], code: string | null, name: string | null): Rate | null {
  if (code) {
    const r = rates.find((x) => x.serviceCode === code);
    if (r) return r;
  }
  if (!name) return null;
  const n = norm(name);
  return rates.find((x) => norm(x.serviceName) === n && !/^(ep|usps):/.test(x.serviceCode)) ?? rates.find((x) => norm(x.serviceName) === n) ?? null;
}

export function compare(s: RedoShipment, rates: Rate[]): Pick<CheckRow, "best_total" | "best_service" | "best_carrier" | "same_total" | "same_service" | "carriers"> {
  const sorted = [...rates].sort((a, b) => a.total - b.total);
  const carriers: CheckRow["carriers"] = {};
  for (const r of sorted) {
    const k = carrierKey(r);
    if (!carriers[k]) carriers[k] = { total: r.total, service: r.serviceName };
  }
  const same = sameServiceRate(rates, s.service_code, s.service_name);
  return {
    best_total: sorted[0]?.total ?? null,
    best_service: sorted[0]?.serviceName ?? null,
    best_carrier: sorted[0] ? carrierKey(sorted[0]) : null,
    same_total: same?.total ?? null,
    same_service: same?.serviceName ?? null,
    carriers,
  };
}

/** Recent Redo shipments that can be checked, newest first. */
async function candidates(env: Env, days: number, limit: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.order_id, s.cost, s.service_code, s.service_name, s.packages, r.shipment_id AS checked
     FROM shipments s LEFT JOIN rate_checks r ON r.shipment_id = s.id
     WHERE s.source = 'redo' AND s.status = 'purchased' AND s.order_id IS NOT NULL AND s.cost > 0 AND s.created_at >= ?
     ORDER BY s.created_at DESC LIMIT ?`,
  ).bind(since, limit).all<RedoShipment & { checked: number | null }>();
  return results;
}

async function save(env: Env, id: number, row: CheckRow) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO rate_checks (shipment_id, checked_at, boxes, weight, box_name, weight_source, redo_cost, redo_service, redo_boxes,
       best_total, best_service, best_carrier, same_total, same_service, carriers, error)
     VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, row.boxes, row.weight, row.box_name, row.weight_source, row.redo_cost, row.redo_service, row.redo_boxes,
      row.best_total, row.best_service, row.best_carrier, row.same_total, row.same_service, JSON.stringify(row.carriers), row.error)
    .run();
}

/** Checks the next few unchecked shipments. The browser calls this until nothing is left. */
export async function checkNext(env: Env, opts: { days: number; limit: number }) {
  const all = await candidates(env, opts.days, opts.limit);
  const todo = all.filter((s) => !s.checked);
  const batch = todo.slice(0, BATCH);
  if (batch.length) {
    const from = await shipFrom(env);
    // A Shopify error stops the run (and shows) rather than marking every order as failed
    const orders: ShopifyOrder[] = await ordersByIds(env, batch.map((s) => s.order_id));
    const byId = new Map(orders.map((o) => [o.id, o]));
    const plans = await planOrders(env, orders);
    await Promise.all(batch.map(async (s) => {
      const base: CheckRow = {
        boxes: null, weight: null, box_name: null, weight_source: null,
        redo_cost: s.cost, redo_service: s.service_name, redo_boxes: redoBoxes(s.packages),
        best_total: null, best_service: null, best_carrier: null, same_total: null, same_service: null, carriers: {}, error: null,
      };
      const o = byId.get(s.order_id);
      const plan = o ? plans.get(o.id) : undefined;
      if (!o || !plan) return save(env, s.id, { ...base, error: "Order not found in Shopify" });
      const row: CheckRow = {
        ...base,
        boxes: plan.parcels.length,
        weight: plan.totalWeight,
        box_name: plan.parcels.length > 1 ? `${plan.parcels.length} boxes` : plan.preset?.name ?? `${plan.parcel.length}×${plan.parcel.width}×${plan.parcel.height}`,
        weight_source: plan.source === "learned" && plan.weightKnown ? "learned" : "product weights",
      };
      if (isInternational(o)) return save(env, s.id, { ...row, error: "International — not compared" });
      if (!plan.weightKnown || !plan.parcels.every((p) => p.weight > 0 && p.length > 0)) return save(env, s.id, { ...row, error: "No weight or box size for these items" });
      try {
        const rates = await getAllRates(env, from, addressFromOrder(o), plan.parcels);
        await save(env, s.id, { ...row, ...compare(s, rates), error: rates.length ? null : "No rates returned" });
      } catch (e) {
        await save(env, s.id, { ...row, error: (e as Error).message.slice(0, 300) });
      }
    }));
  }
  return { total: all.length, remaining: Math.max(0, todo.length - batch.length), checked: batch.length };
}

/** Everything checked so far, newest shipment first. */
export async function checkResults(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, s.order_name, s.created_at AS shipped_at, s.dest_state
     FROM rate_checks r JOIN shipments s ON s.id = r.shipment_id ORDER BY s.created_at DESC LIMIT 1000`,
  ).all<any>();
  return results.map((r) => ({ ...r, carriers: JSON.parse(r.carriers || "{}") }));
}
