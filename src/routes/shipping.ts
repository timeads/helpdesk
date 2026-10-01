import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { findOrderByName, getOrder, ordersByIds, queueOrders, searchOrders, shopifyConfigured, type ShopifyOrder } from "../lib/shopify";
import { getRates, upsConfigured, voidShipment, type Address, type Parcel, type Signature } from "../lib/ups";
import { RULE_ACTIONS, RULE_FIELDS, type ShippingRule } from "../lib/rules";
import {
  addressFromOrder, buyLabel, chooseRate, isInternational, isPaymentPending, isPriority, itemCount, itemsWeightLb,
  loadPresets, loadRules, planOrders, requestedService, shipFrom, shippingPaid, type Plan,
} from "../lib/fulfillment";
import { code128Svg } from "../lib/code128";
import { requireAdmin } from "../lib/auth";
import { HttpError, base64UrlDecodeBytes, getSetting, setSetting } from "../lib/util";
import { demoOrders } from "../lib/demo";
import { importRedoOrders, type RedoOrder } from "../lib/redo-import";
import { escapeHtml } from "../lib/mime";

const shipping = new Hono<AppEnv>();
const demo = (env: Env) => !shopifyConfigured(env) && env.DEMO_DATA === "1";

function validParcels(parcels: Parcel[]): Parcel[] {
  if (!Array.isArray(parcels) || !parcels.length) throw new HttpError(400, "Add at least one package");
  return parcels.map((p, i) => {
    const n = { length: +p.length, width: +p.width, height: +p.height || 0, weight: +p.weight };
    // Height may be 0 for flat envelopes; length, width and weight must be set
    if (!(n.length > 0 && n.width > 0 && n.weight > 0) || n.height < 0) throw new HttpError(400, `Package ${i + 1} needs dimensions and a weight`);
    const contents = Array.isArray(p.contents)
      ? p.contents.filter((x) => x && Number(x.qty) > 0).slice(0, 100).map((x) => ({ id: String(x.id).slice(0, 100), title: String(x.title ?? "").slice(0, 200), qty: Math.round(Number(x.qty)) }))
      : undefined;
    return { ...n, ...(contents?.length ? { contents } : {}), ...(p.box ? { box: String(p.box).slice(0, 100) } : {}) };
  });
}

function validAddress(a: Address): Address {
  for (const k of ["name", "address1", "city", "state", "zip", "country"] as const) {
    if (!a?.[k]?.toString().trim()) throw new HttpError(400, `Ship-to address is missing ${k}`);
  }
  return a;
}

const validSignature = (s: unknown): Signature => (s === "standard" || s === "adult" ? s : null);
const labelFormat = (f: unknown): "GIF" | "ZPL" => (f === "ZPL" ? "ZPL" : "GIF");

async function holdsFor(env: Env, ids: string[]) {
  const map = new Map<string, { status: string; note: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT order_id, status, note FROM order_holds WHERE order_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ order_id: string; status: string; note: string }>();
    for (const r of results) map.set(r.order_id, r);
  }
  return map;
}

async function idSet(env: Env, sql: string, ids: string[]) {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(sql.replace("(?)", `(${chunk.map(() => "?").join(",")})`)).bind(...chunk).all<{ order_id: string }>();
    results.forEach((r) => out.add(r.order_id));
  }
  return out;
}

/** Everything the queue and slideout need about an order, computed once on the server. */
async function describe(env: Env, orders: ShopifyOrder[]) {
  const ids = orders.map((o) => o.id);
  const [plans, holds, labelled, slips] = await Promise.all([
    planOrders(env, orders),
    holdsFor(env, ids),
    idSet(env, "SELECT DISTINCT order_id FROM shipments WHERE status = 'purchased' AND order_id IN (?)", ids),
    idSet(env, "SELECT order_id FROM packing_slip_prints WHERE order_id IN (?)", ids),
  ]);
  return orders.map((o) => {
    const plan = plans.get(o.id)!;
    const h = holds.get(o.id);
    const hold = h?.status === "hold" ? h.note || "On hold" : h?.status === "released" ? null : plan.ruleHold;
    return {
      ...o,
      plan,
      // kept for older clients
      suggestion: plan.rules,
      hold,
      hasLabel: labelled.has(o.id),
      slipPrinted: slips.has(o.id),
      itemCount: itemCount(o),
      itemsWeight: itemsWeightLb(o),
      shippingPaid: shippingPaid(o),
      requestedService: requestedService(o),
      priority: isPriority(o),
      paymentPending: isPaymentPending(o),
      international: isInternational(o),
    };
  });
}

type Described = Awaited<ReturnType<typeof describe>>[number];

const VIEWS: Record<string, (o: Described) => boolean> = {
  ready: (o) => !o.hold && !o.paymentPending && !o.hasLabel,
  priority: (o) => !o.hold && !o.paymentPending && !o.hasLabel && o.priority,
  payment_pending: (o) => o.paymentPending && !o.hasLabel,
  on_hold: (o) => !!o.hold && !o.hasLabel,
  international: (o) => o.international && !o.hasLabel,
  all: () => true,
};

shipping.get("/status", async (c) =>
  c.json({ ups: upsConfigured(c.env), shopify: shopifyConfigured(c.env), upsEnv: c.env.UPS_ENV, demo: demo(c.env) }),
);

/** The fulfillment queue: every open, unshipped order with its plan, plus per-view counts. */
shipping.get("/queue", async (c) => {
  const orders = demo(c.env) ? demoOrders() : await queueOrders(c.env);
  const described = await describe(c.env, orders);
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, f]) => [k, described.filter(f).length]));
  return c.json({ orders: described, counts });
});

shipping.get("/orders", async (c) => {
  const orders = demo(c.env) ? demoOrders() : await searchOrders(c.env, c.req.query("q") ?? "");
  return c.json({ orders: await describe(c.env, orders) });
});

shipping.get("/orders/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const order = demo(c.env) ? demoOrders().find((o) => o.id === id) : await getOrder(c.env, id);
  if (!order) throw new HttpError(404, "Order not found");
  const [d] = await describe(c.env, [order]);
  return c.json({ order: d });
});

/** Scan station: look up an order by the code on its packing slip ("68762-TG", "#68762-TG", "68762"). */
shipping.get("/scan/:code", async (c) => {
  const code = decodeURIComponent(c.req.param("code")).trim();
  let order: ShopifyOrder | undefined;
  if (demo(c.env)) order = demoOrders().find((o) => o.name.replace("#", "").toLowerCase() === code.replace("#", "").toLowerCase());
  else order = await findOrderByName(c.env, code);
  if (!order) throw new HttpError(404, `No order ${code}`);
  const [d] = await describe(c.env, [order]);
  return c.json({ order: d });
});

// ---- Holds
shipping.post("/holds", async (c) => {
  const body = await c.req.json<{ orders: { id: string; name?: string }[]; hold: boolean; note?: string }>();
  const orders = (body.orders ?? []).filter((o) => typeof o.id === "string" && o.id.startsWith("gid://")).slice(0, 200);
  if (!orders.length) throw new HttpError(400, "Pick at least one order");
  await c.env.DB.batch(
    orders.map((o) =>
      c.env.DB.prepare(
        `INSERT INTO order_holds (order_id, order_name, status, note, agent_id, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(order_id) DO UPDATE SET status = excluded.status, note = excluded.note, agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
      ).bind(o.id, o.name ?? null, body.hold ? "hold" : "released", body.hold ? (body.note ?? "").slice(0, 500) : "", c.get("agent").id),
    ),
  );
  return c.json({ ok: true, count: orders.length });
});

// ---- Box library
shipping.get("/presets", async (c) => c.json({ presets: await loadPresets(c.env) }));

shipping.post("/presets", async (c) => {
  const p = await c.req.json<{ name: string; type?: string; length: number; width: number; height: number; weight: number }>();
  if (!p.name?.trim()) throw new HttpError(400, "Name the box");
  const [v] = validParcels([{ ...p, weight: p.weight || 0.01 }]);
  const type = ["box", "envelope", "soft"].includes(p.type ?? "") ? p.type : "box";
  await c.env.DB.prepare("INSERT INTO package_presets (name, type, length, width, height, weight) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p.name.trim(), type, v.length, v.width, v.height, +p.weight || 0)
    .run();
  return c.json({ ok: true });
});

shipping.post("/presets/:id{[0-9]+}/default", async (c) => {
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE package_presets SET is_default = 0"),
    c.env.DB.prepare("UPDATE package_presets SET is_default = 1 WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

shipping.delete("/presets/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM package_presets WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---- Shipping rules (Redo "automations") and package learning
shipping.get("/rules", async (c) =>
  c.json({ rules: await loadRules(c.env), fields: RULE_FIELDS, learning: await getSetting(c.env, "learning", { parcel: true, weight: true }) }),
);

shipping.put("/rules", async (c) => {
  requireAdmin(c);
  const { rules, learning } = await c.req.json<{ rules: Omit<ShippingRule, "id">[]; learning?: { parcel: boolean; weight: boolean } }>();
  if (!Array.isArray(rules)) throw new HttpError(400, "Expected a list of rules");
  const clean = rules.map((r, i) => {
    if (!r.name?.trim()) throw new HttpError(400, `Rule ${i + 1} needs a name`);
    const conditions = (r.conditions ?? []).filter((x) => x.field in RULE_FIELDS && RULE_FIELDS[x.field].ops.includes(x.op) && String(x.value ?? "").trim());
    const actions = (r.actions ?? []).filter((a) => RULE_ACTIONS.includes(a.type) && (a.type === "place_hold" || String(a.value ?? "").trim()));
    if (!conditions.length) throw new HttpError(400, `“${r.name}” needs at least one complete condition`);
    if (!actions.length) throw new HttpError(400, `“${r.name}” needs at least one action`);
    return { name: r.name.trim(), enabled: r.enabled ? 1 : 0, position: i + 1, conditions: JSON.stringify(conditions), actions: JSON.stringify(actions) };
  });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM shipping_rules"),
    ...clean.map((r) =>
      c.env.DB.prepare("INSERT INTO shipping_rules (name, enabled, position, conditions, actions) VALUES (?, ?, ?, ?, ?)").bind(r.name, r.enabled, r.position, r.conditions, r.actions),
    ),
  ]);
  if (learning) await setSetting(c.env, "learning", { parcel: !!learning.parcel, weight: !!learning.weight });
  return c.json({ rules: await loadRules(c.env) });
});

// ---- Rates and labels
shipping.post("/rates", async (c) => {
  const body = await c.req.json<{ to: Address; parcels: Parcel[]; signature?: string }>();
  if (demo(c.env) && !upsConfigured(c.env)) {
    // Local preview only: plausible made-up prices so the screens can be tried without UPS keys
    const lb = validParcels(body.parcels).reduce((n, p) => n + Math.max(p.weight, (p.length * p.width * p.height) / 139), 0);
    const n = body.parcels.length;
    const mk = (serviceCode: string, serviceName: string, base: number, perLb: number, days: number | null) => {
      const total = Math.round((base * n + perLb * lb) * 100) / 100;
      return { serviceCode, serviceName, total, listTotal: Math.round(total * 1.35 * 100) / 100, currency: "USD", days };
    };
    return c.json({ rates: [mk("03", "UPS Ground", 7.4, 0.62, 4), mk("12", "UPS 3 Day Select", 11.2, 1.1, 3), mk("02", "UPS 2nd Day Air", 16.5, 1.9, 2), mk("13", "UPS Next Day Air Saver", 29, 3.2, 1)] });
  }
  const rates = await getRates(c.env, await shipFrom(c.env), validAddress(body.to), validParcels(body.parcels), validSignature(body.signature));
  return c.json({ rates });
});

/** Buy a label for one order (or none) with the box and service chosen in the slideout. */
shipping.post("/labels", async (c) => {
  const body = await c.req.json<{
    orderId?: string;
    ticketId?: number;
    to: Address;
    parcels: Parcel[];
    presetId?: number;
    serviceCode: string;
    serviceName: string;
    listTotal?: number;
    labelFormat?: string;
    fulfill?: boolean;
    notifyCustomer?: boolean;
    signature?: string;
    batchId?: string;
    scanVerified?: boolean;
  }>();
  const order = body.orderId ? (demo(c.env) ? demoOrders().find((o) => o.id === body.orderId) ?? null : await getOrder(c.env, body.orderId)) : null;
  const r = await buyLabel(c.env, c.get("agent"), {
    order,
    ticketId: body.ticketId,
    to: validAddress(body.to),
    parcels: validParcels(body.parcels),
    presetId: body.presetId,
    rate: { serviceCode: body.serviceCode, serviceName: body.serviceName, listTotal: body.listTotal },
    signature: validSignature(body.signature),
    labelFormat: labelFormat(body.labelFormat),
    fulfill: !!body.fulfill && !!order,
    notifyCustomer: body.notifyCustomer ?? true,
    batchId: body.batchId ?? null,
    scanVerified: !!body.scanVerified,
  });
  return c.json(r);
});

/**
 * Bulk / one-click: buy a label for an order using its plan (rule → learned → default box)
 * and a service policy. The browser calls this once per selected order so each stays well
 * inside Cloudflare's per-request limits and progress can be shown.
 */
shipping.post("/labels/auto", async (c) => {
  const body = await c.req.json<{ orderId: string; policy?: string; labelFormat?: string; batchId?: string; notifyCustomer?: boolean; scanVerified?: boolean }>();
  const order = demo(c.env) ? demoOrders().find((o) => o.id === body.orderId) : await getOrder(c.env, body.orderId);
  if (!order) throw new HttpError(404, "Order not found");
  const [d] = await describe(c.env, [order]);
  if (d.hasLabel) throw new HttpError(409, `${order.name} already has a label`);
  if (d.hold) throw new HttpError(409, `${order.name} is on hold: ${d.hold}`);
  const plan: Plan = d.plan;
  if (!plan.weightKnown) throw new HttpError(422, `${order.name}: no weight known — open it to enter one`);
  const to = validAddress(addressFromOrder(order));
  const parcels = validParcels([plan.parcel]);
  const rates = await getRates(c.env, await shipFrom(c.env), to, parcels, plan.signature);
  const policy = !body.policy || body.policy === "rule" ? plan.service ?? "cheapest" : body.policy;
  const rate = chooseRate(rates, policy);
  const r = await buyLabel(c.env, c.get("agent"), {
    order,
    to,
    parcels,
    presetId: plan.preset?.id ?? null,
    rate,
    signature: plan.signature,
    labelFormat: labelFormat(body.labelFormat),
    fulfill: true,
    notifyCustomer: body.notifyCustomer ?? true,
    batchId: body.batchId ?? null,
    scanVerified: !!body.scanVerified,
  });
  return c.json({ ...r, orderName: order.name, serviceName: rate.serviceName });
});

shipping.get("/labels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.order_id, s.order_name, s.service_name, s.tracking_numbers, s.cost, s.currency, s.status, s.fulfilled,
            s.label_format, s.ship_to, s.created_at, s.batch_id, s.shipping_paid, s.signature, a.name AS agent_name
     FROM shipments s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.source IS NULL ORDER BY s.created_at DESC LIMIT 200`,
  ).all<any>();
  return c.json({
    labels: results.map((r) => ({ ...r, tracking_numbers: JSON.parse(r.tracking_numbers), ship_to: JSON.parse(r.ship_to) })),
  });
});

function zplOf(labels: string[]): string {
  return labels.map((l) => new TextDecoder().decode(base64UrlDecodeBytes(l.replace(/\+/g, "-").replace(/\//g, "_")))).join("\n");
}

function labelPage(title: string, gifs: string[]) {
  // UPS GIF labels are landscape; rotate each onto a 4×6 page
  const pages = gifs.map((l) => `<div class="page"><img src="data:image/gif;base64,${l}" alt="UPS label"></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: 4in 6in; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: 4in; height: 6in; overflow: hidden; position: relative; page-break-after: always; }
.page img { position: absolute; top: 0; left: 4in; width: 6in; height: 4in; transform-origin: 0 0; transform: rotate(90deg); }
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center; }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="print()">Print</button> <span>${gifs.length} label${gifs.length === 1 ? "" : "s"} · 4×6 in, margins none, scale 100%</span></div>
${pages}
<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>
</body></html>`;
}

/** Labels to print: ?ids=1,2,3 or ?batch=… . format=zpl returns raw ZPL text for Zebra Browser Print. */
async function labelRows(env: Env, q: { ids?: string; batch?: string }) {
  if (q.batch) {
    const { results } = await env.DB.prepare("SELECT * FROM shipments WHERE batch_id = ? AND status = 'purchased' ORDER BY id").bind(q.batch).all<any>();
    return results;
  }
  const ids = (q.ids ?? "").split(",").map(Number).filter((n) => n > 0).slice(0, 200);
  if (!ids.length) throw new HttpError(400, "No labels selected");
  const { results } = await env.DB.prepare(`SELECT * FROM shipments WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`).bind(...ids).all<any>();
  return results;
}

/** Import a Redo shipping export (the browser parses the CSV and sends ~40 orders per call). */
shipping.post("/import/redo", async (c) => {
  requireAdmin(c);
  const { orders, fresh } = await c.req.json<{ orders: RedoOrder[]; fresh?: boolean }>();
  if (!Array.isArray(orders) || !orders.length) throw new HttpError(400, "No orders in this batch");
  // First batch: get a new Shopify token so recently added scopes (read_all_orders) apply
  if (fresh) await c.env.DB.prepare("DELETE FROM settings WHERE key = 'shopify_access'").run();
  if (orders.length > 60) throw new HttpError(400, "Send at most 60 orders per batch");
  return c.json(await importRedoOrders(c.env, orders, c.get("agent").id));
});

shipping.get("/labels/print", async (c) => {
  const rows = await labelRows(c.env, { ids: c.req.query("ids"), batch: c.req.query("batch") });
  if (!rows.length) throw new HttpError(404, "No labels found");
  if (rows.every((r: any) => r.labels === "[]")) throw new HttpError(404, "These were imported from Redo — reprint them in Redo or UPS");
  const gif = rows.filter((r) => r.label_format !== "ZPL").flatMap((r) => JSON.parse(r.labels) as string[]);
  const zpl = rows.filter((r) => r.label_format === "ZPL").flatMap((r) => JSON.parse(r.labels) as string[]);
  if (c.req.query("format") === "zpl") return c.text(zplOf(zpl));
  if (!gif.length && zpl.length) {
    return new Response(zplOf(zpl), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="labels.zpl"` } });
  }
  return c.html(labelPage(rows.length === 1 ? `Label ${rows[0].order_name ?? ""}` : `${rows.length} labels`, gif));
});

/** Printable label page (GIF) or raw ZPL for thermal printers. */
shipping.get("/labels/:id{[0-9]+}/print", async (c) => {
  const s = await c.env.DB.prepare("SELECT labels, label_format, tracking_numbers, order_name FROM shipments WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ labels: string; label_format: string; tracking_numbers: string; order_name: string | null }>();
  if (!s) throw new HttpError(404, "Label not found");
  const labels: string[] = JSON.parse(s.labels);
  if (!labels.length) throw new HttpError(404, "Imported from Redo — reprint it in Redo or UPS");
  if (s.label_format === "ZPL") {
    if (c.req.query("format") === "zpl") return c.text(zplOf(labels));
    return new Response(zplOf(labels), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="ups-${JSON.parse(s.tracking_numbers)[0]}.zpl"` },
    });
  }
  return c.html(labelPage(`Label ${s.order_name ?? ""}`, labels));
});

shipping.post("/labels/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const s = await c.env.DB.prepare("SELECT shipment_id, status FROM shipments WHERE id = ?").bind(id).first<{ shipment_id: string; status: string }>();
  if (!s) throw new HttpError(404, "Label not found");
  if (s.status === "voided") return c.json({ ok: true });
  if (!s.shipment_id) throw new HttpError(409, "Imported from Redo — void it in Redo or UPS");
  await voidShipment(c.env, s.shipment_id);
  await c.env.DB.prepare("UPDATE shipments SET status = 'voided' WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

/** Label batches: every bulk run (and single labels) grouped for reprinting. */
shipping.get("/batches", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(s.batch_id, 'label-' || s.id) AS batch, MIN(s.created_at) AS created_at, COUNT(*) AS labels,
            SUM(CASE WHEN s.status = 'purchased' THEN s.cost ELSE 0 END) AS cost,
            SUM(CASE WHEN s.status = 'voided' THEN 1 ELSE 0 END) AS voided,
            GROUP_CONCAT(s.order_name, ', ') AS orders, GROUP_CONCAT(s.id) AS ids, MAX(a.name) AS agent_name
     FROM shipments s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.source IS NULL
     GROUP BY COALESCE(s.batch_id, 'label-' || s.id) ORDER BY MIN(s.created_at) DESC LIMIT 100`,
  ).all<any>();
  const imported = await c.env.DB.prepare(
    `SELECT COUNT(*) AS orders, MIN(created_at) AS first, MAX(created_at) AS last,
            SUM(CASE WHEN status = 'purchased' THEN cost ELSE 0 END) AS cost, SUM(COALESCE(shipping_paid, 0)) AS paid,
            SUM(COALESCE(reported_margin, 0)) AS reported
     FROM shipments WHERE source = 'redo'`,
  ).first();
  return c.json({ batches: results, imported });
});

// ---- Packing slips
function packingSlip(o: Described, size: "4x6" | "letter", from: Address | null) {
  const a = (o.shippingAddress ?? {}) as Record<string, string | null>;
  const code = o.name.replace(/^#/, "");
  const lines = o.lineItems.nodes
    .map(
      (l) => `<tr><td class="q">${l.quantity}</td><td><b>${escapeHtml(l.title)}</b>${l.variantTitle ? `<div class="v">${escapeHtml(l.variantTitle)}</div>` : ""}
        <div class="v">${[l.sku ? `SKU ${escapeHtml(l.sku)}` : "", l.variant?.barcode ? `Barcode ${escapeHtml(l.variant.barcode)}` : ""].filter(Boolean).join(" · ")}</div></td></tr>`,
    )
    .join("");
  return `<section class="slip ${size === "letter" ? "letter" : "s4x6"}">
    <header><div><div class="brand">Tuft the World</div>${from ? `<div class="v">${escapeHtml([from.address1, `${from.city}, ${from.state} ${from.zip}`].join(" · "))}</div>` : ""}</div>
      <div class="right"><div class="order">${escapeHtml(o.name)}</div><div class="v">${new Date(o.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div></div></header>
    <div class="cols"><div><div class="lbl">Ship to</div><div>${escapeHtml([a.name, a.company, a.address1, a.address2, `${a.city ?? ""}, ${a.provinceCode ?? ""} ${a.zip ?? ""}`, a.countryCodeV2 !== "US" ? a.country : ""].filter(Boolean).join("\n")).replace(/\n/g, "<br>")}</div></div>
      <div><div class="lbl">Shipping</div><div>${escapeHtml(o.requestedService || "—")}</div>${o.plan.preset ? `<div class="lbl" style="margin-top:6px">Box</div><div>${escapeHtml(o.plan.preset.name)}</div>` : ""}</div></div>
    <table><thead><tr><th class="q">Qty</th><th>Item</th></tr></thead><tbody>${lines}</tbody></table>
    ${o.note ? `<div class="note"><b>Note:</b> ${escapeHtml(o.note)}</div>` : ""}
    <footer>${code128Svg(code, { height: 48, module: 2 })}<div class="v">Scan at the packing station · ${escapeHtml(code)}</div><div class="thanks">Thanks for tufting with us!</div></footer>
  </section>`;
}

shipping.get("/packing-slips", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").map(decodeURIComponent).filter((s) => s.startsWith("gid://")).slice(0, 100);
  if (!ids.length) throw new HttpError(400, "No orders selected");
  const size = c.req.query("size") === "letter" ? "letter" : "4x6";
  const orders = demo(c.env) ? demoOrders().filter((o) => ids.includes(o.id)) : await ordersByIds(c.env, ids);
  const described = await describe(c.env, orders);
  const from = await getSetting<Address | null>(c.env, "ship_from", null);
  await c.env.DB.batch(
    described.map((o) =>
      c.env.DB.prepare(
        "INSERT INTO packing_slip_prints (order_id, printed_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(order_id) DO UPDATE SET printed_at = excluded.printed_at",
      ).bind(o.id),
    ),
  );
  const page = size === "letter" ? "8.5in 11in" : "4in 6in";
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Packing slips</title><style>
@page { size: ${page}; margin: 0; }
html, body { margin: 0; background: #fff; color: #111; font: 11px/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.slip { box-sizing: border-box; page-break-after: always; padding: 0.22in; display: flex; flex-direction: column; gap: 8px; }
.slip.s4x6 { width: 4in; height: 6in; overflow: hidden; }
.slip.letter { width: 8.5in; min-height: 11in; padding: 0.5in; font-size: 13px; gap: 14px; }
header { display: flex; justify-content: space-between; gap: 8px; border-bottom: 2px solid #111; padding-bottom: 6px; }
.brand { font: 400 15px Georgia, serif; text-transform: uppercase; letter-spacing: .04em; }
.order { font-size: 16px; font-weight: 800; text-align: right; }
.right { text-align: right; }
.v { color: #555; font-size: 9.5px; }
.letter .v { font-size: 11px; }
.lbl { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #555; }
.cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 10px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em; color: #555; border-bottom: 1px solid #999; padding: 3px 0; }
td { border-bottom: 1px solid #ddd; padding: 4px 0; vertical-align: top; }
td.q { width: 30px; font-weight: 800; font-size: 12px; }
th.q { width: 30px; }
.note { border: 1px dashed #999; padding: 5px; }
footer { margin-top: auto; text-align: center; }
footer svg { max-width: 100%; height: 40px; }
.thanks { font-weight: 700; margin-top: 2px; }
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center; }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="print()">Print</button><span>${described.length} packing slip${described.length === 1 ? "" : "s"} · ${size === "letter" ? "Letter" : "4×6"}</span></div>
${described.map((o) => packingSlip(o, size, from)).join("")}
<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>
</body></html>`);
});

export default shipping;
