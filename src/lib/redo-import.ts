// Redo shipping export → shipments. Redo lists one row per box and repeats the order's shipping
// payment on every box, so its margin counts the customer's payment once per box. Here each order
// becomes one shipment: every box's label cost added up, the customer's payment counted once
// (from Shopify when we can find the order, after shipping refunds).
import type { Env } from "../env";
import { shopify, shopifyConfigured } from "./shopify";

export interface RedoBox {
  tracking: string;
  status: string;
  shipped: string; // "Oct 1, 2026"
  selection: string; // "UPS® Ground - 7.90 - 1"
  rate: number | null;
  paid: number | null;
  margin: number | null;
}
export interface RedoOrder {
  order: string;
  customer: string;
  orderDate: string;
  boxes: RedoBox[];
}

const SERVICE_CODES: [RegExp, string][] = [
  [/ground saver/i, "93"],
  [/next day air saver/i, "13"],
  [/next day air early/i, "14"],
  [/next day air/i, "01"],
  [/2nd day air a\.?m/i, "59"],
  [/2nd day air/i, "02"],
  [/3 day select/i, "12"],
  [/ups.*standard/i, "11"],
  [/ups.*ground/i, "03"],
];

export function parseSelection(sel: string): { carrier: string; service: string; code: string } {
  const name = sel.replace(/\s+-\s+[\w.]+\s+-\s+[\w.]+\s*$/, "").replace(/[®™]/g, "").replace(/\s+/g, " ").trim();
  const carrier = /usps/i.test(name) ? "USPS" : /fedex/i.test(name) ? "FedEx" : /dhl/i.test(name) ? "DHL" : "UPS";
  const code = SERVICE_CODES.find(([re]) => re.test(name))?.[1] ?? "";
  return { carrier, service: !name || /unknown/i.test(name) ? `${carrier}` : name, code };
}

/** "Oct 1, 2026" → ISO at noon Eastern (keeps the calendar day in reports). */
export function redoDate(s: string): string | null {
  const t = Date.parse(`${s} 12:00 GMT-0500`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface ShopifyShipInfo {
  id: string;
  name: string;
  createdAt: string;
  paid: number; // shipping after refunds and discounts
  orderTotal: number;
  requested: string | null;
  state: string | null;
  country: string | null;
}

export async function lookupOrders(env: Env, names: string[]): Promise<Map<string, ShopifyShipInfo>> {
  const out = new Map<string, ShopifyShipInfo>();
  const real = names.filter((n) => /^#\S+$/.test(n));
  if (!real.length || !shopifyConfigured(env)) return out;
  for (let i = 0; i < real.length; i += 25) {
    const chunk = real.slice(i, i + 25);
    const data = await shopify<{ orders: { nodes: any[] } }>(
      env,
      `query Ship($q: String!, $n: Int!) { orders(first: $n, query: $q) { nodes {
        id name createdAt
        currentShippingPriceSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        shippingLines(first: 1) { nodes { title } }
        shippingAddress { provinceCode countryCodeV2 }
      } } }`,
      { q: chunk.map((n) => `name:${JSON.stringify(n)}`).join(" OR "), n: chunk.length },
    );
    for (const o of data.orders.nodes) {
      out.set(o.name, {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        paid: Number(o.currentShippingPriceSet?.shopMoney.amount ?? 0),
        orderTotal: Number(o.currentTotalPriceSet?.shopMoney.amount ?? 0),
        requested: o.shippingLines.nodes[0]?.title ?? null,
        state: o.shippingAddress?.provinceCode ?? null,
        country: o.shippingAddress?.countryCodeV2 ?? null,
      });
    }
  }
  return out;
}

export interface ImportedOrder {
  order: string;
  boxes: number;
  cost: number;
  paid: number;
  paidSource: "shopify" | "redo";
  margin: number;
  reportedMargin: number;
  voided: boolean;
  notes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A tracking number listed on two orders (two orders shipped in one box) belongs to the order whose
 * row has a real service and status; the other order just shows no extra cost.
 */
export function trackingOwners(orders: RedoOrder[]): Map<string, string> {
  const best = new Map<string, { order: string; score: number }>();
  for (const o of orders) {
    for (const b of o.boxes) {
      if (!b.tracking) continue;
      const score = (/unknown/i.test(b.selection) || !b.selection ? 0 : 2) + (b.status ? 1 : 0);
      const cur = best.get(b.tracking);
      if (!cur || score > cur.score) best.set(b.tracking, { order: o.order, score });
    }
  }
  return new Map([...best].map(([t, v]) => [t, v.order]));
}

/** Pure part: one order's boxes → totals (tested). */
export function summarize(o: RedoOrder, shop: ShopifyShipInfo | undefined, owner: Map<string, string>) {
  const notes: string[] = [];
  const shipped = o.boxes.filter((b) => b.tracking);
  const live: RedoBox[] = [];
  let cancelled = 0;
  for (const b of shipped) {
    if (/cancel/i.test(b.status)) { cancelled++; notes.push(`${b.tracking} cancelled — not counted`); continue; }
    const own = owner.get(b.tracking);
    if (own && own !== o.order) { notes.push(`${b.tracking} shipped with ${own} — counted there`); continue; }
    live.push(b);
  }
  const cost = round2(live.reduce((n, b) => n + (b.rate ?? 0), 0));
  // Redo repeats the payment on every box; the customer paid it once
  const redoPaids = shipped.map((b) => b.paid).filter((x): x is number => x !== null);
  const redoPaid = redoPaids.length ? Math.min(...redoPaids) : 0;
  const paid = round2(shop ? shop.paid : redoPaid);
  if (shop && Math.abs(shop.paid - redoPaid) > 0.01) notes.push(`Shopify shows $${shop.paid.toFixed(2)} shipping paid; Redo shows $${redoPaid.toFixed(2)}`);
  const reported = round2(shipped.reduce((n, b) => n + (b.margin ?? 0), 0));
  return { live, shipped, cost, paid, reported, notes, voided: shipped.length > 0 && cancelled === shipped.length };
}

export async function importRedoOrders(env: Env, orders: RedoOrder[], agentId: number) {
  const shop = await lookupOrders(env, [...new Set(orders.map((o) => o.order))]);
  const owners = trackingOwners(orders);
  const results: ImportedOrder[] = [];
  let skipped = 0;
  for (const o of orders) {
    const s = shop.get(o.order);
    const ref = `redo:${o.order}`;
    const sum = summarize(o, s, owners);
    if (!sum.shipped.length) { skipped++; continue; } // no label in Redo (not shipped, or shipped another way)
    // A tracking number already stored on a different imported order counts there
    for (const b of [...sum.live]) {
      const dup = await env.DB.prepare("SELECT order_name FROM shipments WHERE source = 'redo' AND source_ref != ? AND tracking_numbers LIKE ?")
        .bind(ref, `%"${b.tracking}"%`).first<{ order_name: string }>();
      if (dup) {
        sum.live.splice(sum.live.indexOf(b), 1);
        sum.cost = round2(sum.cost - (b.rate ?? 0));
        sum.notes.push(`${b.tracking} shipped with ${dup.order_name} — counted there`);
      }
    }
    const services = sum.live.length ? sum.live : sum.shipped;
    const parsed = services.map((b) => parseSelection(b.selection));
    const main = parsed.find((p) => p.code) ?? parsed[0];
    const dates = sum.shipped.map((b) => redoDate(b.shipped)).filter(Boolean).sort() as string[];
    const packages = sum.shipped.map((b) => ({ tracking: b.tracking, rate: b.rate, status: b.status, shipped: b.shipped, counted: sum.live.includes(b) }));
    await env.DB.prepare(
      `INSERT INTO shipments (order_id, order_name, carrier, service_code, service_name, tracking_numbers, labels, label_format, cost, currency,
         packages, ship_to, status, fulfilled, agent_id, created_at, batch_id, shipping_paid, order_total, order_created_at, requested_service,
         item_count, dest_state, dest_country, source, source_ref, delivery_status, reported_margin)
       VALUES (?, ?, ?, ?, ?, ?, '[]', 'GIF', ?, 'USD', ?, ?, ?, 1, ?, ?, 'Redo import', ?, ?, ?, ?, NULL, ?, ?, 'redo', ?, ?, ?)
       ON CONFLICT(source_ref) DO UPDATE SET order_id = excluded.order_id, carrier = excluded.carrier, service_code = excluded.service_code,
         service_name = excluded.service_name, tracking_numbers = excluded.tracking_numbers, cost = excluded.cost, packages = excluded.packages,
         ship_to = excluded.ship_to, status = excluded.status, created_at = excluded.created_at, shipping_paid = excluded.shipping_paid,
         order_total = excluded.order_total, order_created_at = excluded.order_created_at, requested_service = excluded.requested_service,
         dest_state = excluded.dest_state, dest_country = excluded.dest_country, delivery_status = excluded.delivery_status,
         reported_margin = excluded.reported_margin`,
    )
      .bind(
        s?.id ?? null,
        o.order,
        main?.carrier ?? "UPS",
        main?.code ?? "",
        main?.service ?? "UPS",
        JSON.stringify(sum.live.map((b) => b.tracking)),
        sum.cost,
        JSON.stringify(packages),
        JSON.stringify({ name: o.customer }),
        sum.voided ? "voided" : "purchased",
        agentId,
        dates[0] ?? new Date().toISOString(),
        sum.paid,
        s?.orderTotal ?? null,
        s?.createdAt ?? redoDate(o.orderDate),
        s?.requested ?? null,
        s?.state ?? null,
        s?.country ?? null,
        ref,
        [...new Set(sum.shipped.map((b) => b.status).filter(Boolean))].join(", ") || null,
        sum.reported,
      )
      .run();
    results.push({
      order: o.order,
      boxes: sum.shipped.length,
      cost: sum.cost,
      paid: sum.paid,
      paidSource: s ? "shopify" : "redo",
      margin: round2(sum.paid - sum.cost),
      reportedMargin: sum.reported,
      voided: sum.voided,
      notes: sum.notes,
    });
  }
  return { results, skipped, shopifyFound: shop.size };
}
