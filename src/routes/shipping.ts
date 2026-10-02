import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { remaining, cancelFulfillment, fulfillOrder, markReadyForPickup, findOrderByName, getOrder, ordersByIds, queueOrders, searchOrders, shopifyConfigured, type ShopifyOrder } from "../lib/shopify";
import { upsConfigured, type Address, type Parcel, type Signature } from "../lib/ups";
import { anyCarrier, getAllRates as getRates, trackingUrlFor, voidLabel } from "../lib/carriers";
import { easypostConfigured } from "../lib/easypost";
import { checkAddress } from "../lib/address";
import { buildCustoms, cleanCustoms, customsProblems, customsSettings, loadProfiles, type Customs } from "../lib/customs";
import { isInternationalAddress, normalizePhone, splitCost } from "../lib/ups";
import { RULE_ACTIONS, RULE_FIELDS, type ShippingRule } from "../lib/rules";
import {
  addressFromOrder, buyLabel, chooseRate, isInternational, isPickup, isPaymentPending, isPriority, itemCount, itemsWeightLb,
  loadPresets, loadRules, planOrders, requestedService, shipFrom, shippingPaid, type Plan,
} from "../lib/fulfillment";
import { code128Svg } from "../lib/code128";
import { requireAdmin } from "../lib/auth";
import { HttpError, base64UrlDecodeBytes, getSetting, setSetting } from "../lib/util";
import { demoOrders } from "../lib/demo";
import { importRedoOrders, type RedoOrder } from "../lib/redo-import";
import { escapeHtml } from "../lib/mime";
import { applyDraft, cleanDraft, deleteDraft, loadDrafts, saveDraft } from "../lib/drafts";
import { SLIP_CSS, cleanSlip, renderSlip, slipLayout, type SlipBox } from "../lib/slip";

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
    return {
      ...n,
      ...(contents?.length ? { contents } : {}),
      ...(p.box ? { box: String(p.box).slice(0, 100) } : {}),
      ...(Number(p.presetId) > 0 ? { presetId: Number(p.presetId) } : {}),
    };
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

/** A partial shipment from the browser: [{ id: line item id, qty }] limited to what the order has left. */
function cleanPartial(raw: unknown, order: ShopifyOrder | null) {
  if (!order || !Array.isArray(raw)) return null;
  const left = new Map(order.lineItems.nodes.map((l) => [l.id, l.quantity]));
  const list = raw
    .map((x: any) => ({ id: String(x?.id ?? ""), qty: Math.max(0, Math.round(Number(x?.qty) || 0)) }))
    .filter((x) => left.has(x.id))
    .map((x) => ({ ...x, qty: Math.min(x.qty, left.get(x.id)!) }));
  if (!list.some((x) => x.qty > 0)) throw new HttpError(400, "Pick at least one item to ship now");
  return list;
}

/** The order with only the quantities being shipped now (for planning boxes and customs). */
const subsetOrder = (o: ShopifyOrder, partial: { id: string; qty: number }[]): ShopifyOrder => ({
  ...o,
  lineItems: { ...o.lineItems, nodes: o.lineItems.nodes.map((l) => ({ ...l, quantity: partial.find((x) => x.id === l.id)?.qty ?? 0 })).filter((l) => l.quantity > 0) },
});

/** Customs for just the items in a partial shipment. */
const customsFor = (c: Customs | undefined, partial: { id: string; qty: number }[] | null): Customs | undefined =>
  c && partial ? { ...c, items: c.items.map((i) => ({ ...i, qty: partial.find((x) => x.id === i.lineId)?.qty ?? 0 })).filter((i) => i.qty > 0) } : c;

/** Today's date where the store is (Philadelphia), as YYYY-MM-DD. */
const storeToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function holdsFor(env: Env, ids: string[]) {
  const map = new Map<string, { status: string; note: string; hold_until: string | null }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT order_id, status, note, hold_until FROM order_holds WHERE order_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ order_id: string; status: string; note: string; hold_until: string | null }>();
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

async function idMap(env: Env, sql: string, ids: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(sql.replace("(?)", `(${chunk.map(() => "?").join(",")})`)).bind(...chunk).all<{ order_id: string; v: string }>();
    results.forEach((r) => out.set(r.order_id, r.v));
  }
  return out;
}

/** Everything the queue and slideout need about an order, computed once on the server. */
async function describe(env: Env, all: ShopifyOrder[]) {
  const orders = all.map(remaining); // after a partial shipment, only what's still to ship
  const ids = orders.map((o) => o.id);
  const [plans, holds, labelled, slips, drafts, presets, pickups] = await Promise.all([
    planOrders(env, orders),
    holdsFor(env, ids),
    idSet(env, "SELECT DISTINCT order_id FROM shipments WHERE status = 'purchased' AND COALESCE(partial, 0) = 0 AND order_id IN (?)", ids),
    idMap(env, "SELECT order_id, printed_at AS v FROM packing_slip_prints WHERE order_id IN (?)", ids),
    loadDrafts(env, ids),
    loadPresets(env),
    idMap(env, "SELECT order_id, COALESCE(ready_at, '') || '|' || COALESCE(picked_up_at, '') AS v FROM pickup_status WHERE order_id IN (?)", ids),
  ]);
  return orders.map((o) => {
    const draft = drafts.get(o.id) ?? null;
    const base = plans.get(o.id)!;
    const plan = draft ? applyDraft(base, draft, presets, o.lineItems.nodes.map((l) => l.id)) : base;
    const h = holds.get(o.id);
    // A dated hold ends by itself: from that day (store time) the order is back in the queue
    const holdEnded = h?.status === "hold" && h.hold_until && h.hold_until <= storeToday() ? h.hold_until : null;
    const hold = h?.status === "hold" && !holdEnded ? h.note || "On hold" : h?.status === "released" || holdEnded ? null : plan.ruleHold;
    return {
      ...o,
      plan,
      draft,
      // kept for older clients
      suggestion: plan.rules,
      hold,
      holdUntil: hold && h?.status === "hold" ? h.hold_until : null,
      holdEnded,
      hasLabel: labelled.has(o.id),
      slipPrinted: slips.has(o.id),
      slipPrintedAt: slips.get(o.id) ?? null,
      itemCount: itemCount(o),
      itemsWeight: itemsWeightLb(o),
      shippingPaid: shippingPaid(o),
      requestedService: requestedService(o),
      priority: isPriority(o),
      paymentPending: isPaymentPending(o),
      international: isInternational(o),
      pickup: isPickup(o),
      pickupReadyAt: pickups.get(o.id)?.split("|")[0] || null,
      pickedUpAt: pickups.get(o.id)?.split("|")[1] || null,
    };
  });
}

type Described = Awaited<ReturnType<typeof describe>>[number];

const VIEWS: Record<string, (o: Described) => boolean> = {
  ready: (o) => !o.hold && !o.paymentPending && !o.hasLabel && !o.pickup,
  priority: (o) => !o.hold && !o.paymentPending && !o.hasLabel && !o.pickup && o.priority,
  pickup: (o) => o.pickup && !o.pickedUpAt,
  payment_pending: (o) => o.paymentPending && !o.hasLabel,
  on_hold: (o) => !!o.hold && !o.hasLabel,
  international: (o) => o.international && !o.hasLabel && !o.pickup,
  all: () => true,
};

shipping.get("/status", async (c) =>
  c.json({ ups: upsConfigured(c.env), usps: easypostConfigured(c.env), shopify: shopifyConfigured(c.env), upsEnv: c.env.UPS_ENV, demo: demo(c.env) }),
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

// ---- Choices saved from the order page (boxes, split, service, address) until a label is bought
shipping.put("/drafts/:id", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  if (!id.startsWith("gid://shopify/Order/")) throw new HttpError(400, "Unknown order");
  const draft = cleanDraft(await c.req.json());
  if (!draft) throw new HttpError(400, "Nothing to save");
  await saveDraft(c.env, id, draft);
  return c.json({ ok: true });
});

shipping.delete("/drafts/:id", async (c) => {
  await deleteDraft(c.env, decodeURIComponent(c.req.param("id")));
  return c.json({ ok: true });
});

/** Scan station: look up an order by the code on its packing slip ("68762-TG", "#68762-TG", "68762"). */
shipping.get("/scan/:code", async (c) => {
  const raw = decodeURIComponent(c.req.param("code")).trim();
  // A box's packing slip: "1042/B2" (some scanners turn "/" into "-" or "?", so be forgiving)
  const boxMatch = /^(.*?)[\/?\-\s]B(\d{1,2})$/i.exec(raw);
  const code = boxMatch ? boxMatch[1] : raw;
  let order: ShopifyOrder | undefined;
  if (demo(c.env)) order = demoOrders().find((o) => o.name.replace("#", "").toLowerCase() === code.replace("#", "").toLowerCase());
  else order = await findOrderByName(c.env, code);
  if (!order) throw new HttpError(404, `No order ${code}`);
  const [d] = await describe(c.env, [order]);
  // Every box of the order (from the bought shipment, else the planned boxes), so each slip can be packed on its own
  const slips = await slipsFor(c.env, [d]);
  const boxes = slips.filter((x) => x.box).map((x) => ({ n: x.box!.n, of: x.box!.of, name: x.box!.name, tracking: x.box!.tracking, qty: x.box!.qty }));
  const n = boxMatch ? Number(boxMatch[2]) : null;
  if (n && boxes.length && !boxes.some((b) => b.n === n)) throw new HttpError(404, `${d.name} doesn't have a box ${n} any more — its boxes changed. Reprint its packing slips.`);
  const bought = await c.env.DB.prepare("SELECT id, tracking_numbers, printed_boxes FROM shipments WHERE order_id = ? AND status = 'purchased' AND COALESCE(partial, 0) = 0 ORDER BY id DESC LIMIT 1")
    .bind(d.id).first<{ id: number; tracking_numbers: string; printed_boxes: string }>();
  return c.json({ order: d, boxes, box: n && boxes.length ? n : null, shipmentId: bought?.id ?? null, printedBoxes: bought ? Object.keys(printedBoxes(bought)).map(Number) : [] });
});

// ---- Holds
shipping.post("/holds", async (c) => {
  const body = await c.req.json<{ orders: { id: string; name?: string }[]; hold: boolean; note?: string; until?: string | null }>();
  const until = body.hold && typeof body.until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.until) ? body.until : null;
  if (until && until <= storeToday()) throw new HttpError(400, "Pick a day after today");
  const orders = (body.orders ?? []).filter((o) => typeof o.id === "string" && o.id.startsWith("gid://")).slice(0, 200);
  if (!orders.length) throw new HttpError(400, "Pick at least one order");
  await c.env.DB.batch(
    orders.map((o) =>
      c.env.DB.prepare(
        `INSERT INTO order_holds (order_id, order_name, status, note, hold_until, agent_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(order_id) DO UPDATE SET status = excluded.status, note = excluded.note, hold_until = excluded.hold_until, agent_id = excluded.agent_id, updated_at = excluded.updated_at`,
      ).bind(o.id, o.name ?? null, body.hold ? "hold" : "released", body.hold ? (body.note ?? "").slice(0, 500) : "", until, c.get("agent").id),
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

// ---- Customs (international)
/** Defaults and remembered per-product customs details, for building the customs list in the browser. */
shipping.post("/customs", async (c) => {
  const { keys } = await c.req.json<{ keys: string[] }>();
  const profiles = await loadProfiles(c.env, (keys ?? []).slice(0, 200).map(String));
  return c.json({ settings: await customsSettings(c.env), profiles: Object.fromEntries(profiles) });
});

/** Customs paperwork for a label (commercial invoice / CN23), as a PDF. */
shipping.get("/labels/:id{[0-9]+}/forms/:n{[0-9]+}", async (c) => {
  const row = await c.env.DB.prepare("SELECT forms, order_name FROM shipments WHERE id = ?").bind(Number(c.req.param("id"))).first<{ forms: string; order_name: string | null }>();
  const forms = JSON.parse(row?.forms || "[]") as { type: string; data: string }[];
  const f = forms[Number(c.req.param("n"))];
  if (!f) throw new HttpError(404, "No customs form");
  return new Response(base64UrlDecodeBytes(f.data.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")), {
    headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${(row?.order_name ?? "label").replace(/[^\w-]/g, "")}-customs-${Number(c.req.param("n")) + 1}.pdf"` },
  });
});

// ---- Address verification
shipping.post("/verify-address", async (c) => {
  const { address, fresh } = await c.req.json<{ address: Address; fresh?: boolean }>();
  if (demo(c.env) && !anyCarrier(c.env)) {
    // Local preview: one sample address gets a suggested correction so the screens can be seen
    if (/detroit/i.test(address.city ?? "") && !/^100 W /i.test(address.address1 ?? "")) {
      return c.json({ status: "corrected", residential: true, provider: "UPS", message: "UPS suggests a corrected address",
        suggestion: { ...address, address1: "100 W Example St", zip: `${(address.zip ?? "").slice(0, 5)}-1204` } });
    }
    return c.json({ status: "valid", residential: !address.company, suggestion: null, provider: "UPS", message: "Verified by UPS (sample)" });
  }
  return c.json(await checkAddress(c.env, address, { fresh: !!fresh }));
});

// ---- Rates and labels
shipping.post("/rates", async (c) => {
  const body = await c.req.json<{ to: Address; parcels: Parcel[]; signature?: string; customs?: unknown }>();
  const customs = cleanCustoms(body.customs);
  if (demo(c.env) && !anyCarrier(c.env)) {
    // Local preview only: plausible made-up prices so the screens can be tried without UPS keys
    const lb = validParcels(body.parcels).reduce((n, p) => n + Math.max(p.weight, (p.length * p.width * p.height) / 139), 0);
    const n = body.parcels.length;
    const boxLb = validParcels(body.parcels).map((p) => Math.max(p.weight, (p.length * p.width * p.height) / 139));
    const mk = (serviceCode: string, serviceName: string, base: number, perLb: number, days: number | null) => {
      const total = Math.round((base * n + perLb * lb) * 100) / 100;
      const perBox = n > 1 ? splitCost(total, boxLb.map((w) => base + perLb * w)) : undefined;
      return { serviceCode, serviceName, total, listTotal: Math.round(total * 1.35 * 100) / 100, currency: "USD", days, ...(perBox ? { perBox } : {}) };
    };
    const usps = (code: string, name: string, base: number, perLb: number, days: number) => ({ ...mk(code, name, base, perLb, days), carrier: "USPS" });
    if ((body.to.country || "US").toUpperCase() !== "US") {
      if (!customs) return c.json({ rates: [] });
      return c.json({ rates: [
        { ...mk("11", "UPS Standard", 18, 1.4, 5), carrier: "UPS" }, { ...mk("65", "UPS Worldwide Saver", 42, 3.1, 2), carrier: "UPS" },
        usps("usps:FirstClassPackageInternationalService", "USPS First-Class Package International", 16, 2.2, 10), usps("usps:PriorityMailInternational", "USPS Priority Mail International", 38, 2.6, 7),
      ].sort((a, b) => a.total - b.total) });
    }
    const rates = [
      { ...mk("03", "UPS Ground", 7.4, 0.62, 4), carrier: "UPS" }, { ...mk("12", "UPS 3 Day Select", 11.2, 1.1, 3), carrier: "UPS" },
      { ...mk("02", "UPS 2nd Day Air", 16.5, 1.9, 2), carrier: "UPS" }, { ...mk("13", "UPS Next Day Air Saver", 29, 3.2, 1), carrier: "UPS" },
      usps("usps:GroundAdvantage", "USPS Ground Advantage", 5.9, 0.7, 4), usps("usps:Priority", "USPS Priority Mail", 8.4, 0.9, 2), usps("usps:Express", "USPS Priority Mail Express", 27, 1.6, 1),
    ];
    return c.json({ rates: rates.sort((a, b) => a.total - b.total) });
  }
  const rates = await getRates(c.env, await shipFrom(c.env), validAddress(body.to), validParcels(body.parcels), validSignature(body.signature), customs);
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
    perBox?: number[];
    labelFormat?: string;
    fulfill?: boolean;
    notifyCustomer?: boolean;
    signature?: string;
    batchId?: string;
    scanVerified?: boolean;
    customs?: unknown;
  }>();
  const found = body.orderId ? (demo(c.env) ? demoOrders().find((o) => o.id === body.orderId) ?? null : await getOrder(c.env, body.orderId)) : null;
  const order = found ? remaining(found) : null;
  const partial = cleanPartial((body as any).partial, order);
  const to = validAddress(body.to);
  let customs = customsFor(cleanCustoms(body.customs), partial);
  if (isInternationalAddress(to)) {
    if (!customs && order) customs = await buildCustoms(c.env, partial ? subsetOrder(order, partial) : order);
    if (!customs) throw new HttpError(422, "International shipments need customs details");
    const problems = customsProblems(customs);
    if (problems.length) throw new HttpError(422, problems.join(" · "));
  }
  const r = await buyLabel(c.env, c.get("agent"), {
    customs: isInternationalAddress(to) ? customs : undefined,
    order,
    ticketId: body.ticketId,
    to,
    parcels: validParcels(body.parcels),
    presetId: body.presetId,
    rate: {
      serviceCode: body.serviceCode, serviceName: body.serviceName, listTotal: body.listTotal,
      perBox: Array.isArray(body.perBox) ? body.perBox.slice(0, 20).map((x) => Math.max(0, Number(x) || 0)) : undefined,
    },
    signature: validSignature(body.signature),
    labelFormat: labelFormat(body.labelFormat),
    fulfill: !!body.fulfill && !!order,
    notifyCustomer: body.notifyCustomer ?? true,
    batchId: body.batchId ?? null,
    scanVerified: !!body.scanVerified,
    partial,
  });
  return c.json(r);
});

/**
 * Bulk / one-click: buy a label for an order using its plan (rule → learned → default box)
 * and a service policy. The browser calls this once per selected order so each stays well
 * inside Cloudflare's per-request limits and progress can be shown.
 */
shipping.post("/labels/auto", async (c) => {
  const body = await c.req.json<{ orderId: string; policy?: string; labelFormat?: string; batchId?: string; notifyCustomer?: boolean; scanVerified?: boolean; partial?: unknown; parcels?: unknown }>();
  const found = demo(c.env) ? demoOrders().find((o) => o.id === body.orderId) : await getOrder(c.env, body.orderId);
  if (!found) throw new HttpError(404, "Order not found");
  const order = remaining(found);
  const partial = cleanPartial(body.partial, order);
  const [d] = await describe(c.env, [order]);
  if (d.hasLabel) throw new HttpError(409, `${order.name} already has a label`);
  if (d.hold) throw new HttpError(409, `${order.name} is on hold: ${d.hold}`);
  const plan: Plan = d.plan;
  if (!plan.weightKnown && !body.parcels && !partial) throw new HttpError(422, `${order.name}: no weight known — open it to enter one`);
  let to = validAddress(d.draft?.to ?? addressFromOrder(order));
  // Don't buy a label for an address the carrier can't find or wants to correct
  const customs = isInternationalAddress(to) ? await buildCustoms(c.env, partial ? subsetOrder(order, partial) : order) : undefined;
  if (customs) {
    const problems = customsProblems(customs);
    if (problems.length) throw new HttpError(422, `${order.name}: ${problems[0]} — open it to fix the customs list`);
  }
  const check = await checkAddress(c.env, to);
  if (check.status === "invalid") throw new HttpError(422, `${order.name}: ${check.message.toLowerCase()} — open it to fix the address`);
  if (check.status === "corrected" || check.status === "ambiguous") throw new HttpError(422, `${order.name}: ${check.message.toLowerCase()} — open it to review`);
  if (check.residential !== null) to = { ...to, residential: check.residential };
  // Every box from the plan (a remembered multi-box packing ships as one multi-box shipment)
  const titles = new Map(order.lineItems.nodes.map((l) => [l.id, l.title + (l.variantTitle ? ` · ${l.variantTitle}` : "")]));
  // The packing station can send the box it actually used (and, shipping part of the order, what's in it)
  const boxPlan = partial && !(Array.isArray(body.parcels) && body.parcels.length) ? (await planOrders(c.env, [subsetOrder(order, partial)])).get(order.id) ?? plan : plan;
  if (!boxPlan.weightKnown && !(Array.isArray(body.parcels) && body.parcels.length)) throw new HttpError(422, `${order.name}: no weight known for these items — set the box weight`);
  const parcels = Array.isArray(body.parcels) && body.parcels.length ? validParcels(body.parcels) : validParcels(
    boxPlan.boxes.map((b) => ({
      ...b.parcel,
      presetId: b.preset?.id ?? null,
      box: b.preset?.name,
      contents: boxPlan.boxes.length > 1 || partial ? Object.entries(b.items).filter(([, q]) => q > 0).map(([id, qty]) => ({ id, title: titles.get(id) ?? "", qty })) : undefined,
    })),
  );
  const rates = await getRates(c.env, await shipFrom(c.env), to, parcels, plan.signature, customs);
  const policy = !body.policy || body.policy === "rule" ? plan.service ?? "cheapest" : body.policy;
  const rate = chooseRate(rates, policy);
  const r = await buyLabel(c.env, c.get("agent"), {
    order,
    to,
    parcels,
    presetId: boxPlan.preset?.id ?? null,
    rate,
    signature: plan.signature,
    labelFormat: labelFormat(body.labelFormat),
    fulfill: true,
    notifyCustomer: body.notifyCustomer ?? true,
    batchId: body.batchId ?? null,
    scanVerified: !!body.scanVerified,
    customs,
    partial,
  });
  return c.json({ ...r, orderName: order.name, serviceName: rate.serviceName });
});

// ---- In-store pickup: "ready for pickup" (Shopify emails the customer), then "picked up" (fulfilled)
shipping.post("/pickup/:id/ready", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  if (!demo(c.env)) await markReadyForPickup(c.env, id);
  await c.env.DB.prepare(
    `INSERT INTO pickup_status (order_id, order_name, ready_at, agent_id) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(order_id) DO UPDATE SET ready_at = excluded.ready_at, agent_id = excluded.agent_id`,
  ).bind(id, name ?? null, c.get("agent").id).run();
  return c.json({ ok: true });
});

shipping.post("/pickup/:id/picked-up", async (c) => {
  const id = decodeURIComponent(c.req.param("id"));
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  if (!demo(c.env)) await fulfillOrder(c.env, id, null, false);
  await c.env.DB.prepare(
    `INSERT INTO pickup_status (order_id, order_name, picked_up_at, agent_id) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(order_id) DO UPDATE SET picked_up_at = excluded.picked_up_at, agent_id = excluded.agent_id`,
  ).bind(id, name ?? null, c.get("agent").id).run();
  return c.json({ ok: true });
});

/** A label whose Shopify fulfillment failed (e.g. a missing scope): try marking the order fulfilled again. */
shipping.post("/labels/:id{[0-9]+}/fulfill", async (c) => {
  const id = Number(c.req.param("id"));
  const { notifyCustomer } = await c.req.json<{ notifyCustomer?: boolean }>().catch(() => ({ notifyCustomer: undefined }));
  const s = await c.env.DB.prepare("SELECT order_id, carrier, tracking_numbers, status, fulfilled FROM shipments WHERE id = ?").bind(id)
    .first<{ order_id: string | null; carrier: string | null; tracking_numbers: string; status: string; fulfilled: number }>();
  if (!s || !s.order_id) throw new HttpError(404, "Label not found");
  if (s.status !== "purchased") throw new HttpError(409, "This label was voided");
  if (s.fulfilled) return c.json({ ok: true, already: true });
  const numbers = JSON.parse(s.tracking_numbers || "[]") as string[];
  const carrier = s.carrier ?? "UPS";
  const f = await fulfillOrder(c.env, s.order_id, { company: carrier, numbers, urls: numbers.map((n) => trackingUrlFor(carrier, n)) }, notifyCustomer ?? true);
  await c.env.DB.prepare("UPDATE shipments SET fulfilled = 1, fulfillment_id = ? WHERE id = ?").bind(f?.id ?? null, id).run();
  return c.json({ ok: true });
});

shipping.get("/labels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.carrier, json_array_length(s.forms) AS forms, s.order_id, s.order_name, s.service_name, s.tracking_numbers, s.cost, s.currency, s.status, s.fulfilled,
            s.label_format, s.ship_to, s.created_at, s.batch_id, s.shipping_paid, s.signature, a.name AS agent_name
     FROM shipments s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.source IS NULL AND (? IS NULL OR s.order_id = ?) ORDER BY s.created_at DESC LIMIT 200`,
  ).bind(c.req.query("order") ?? null, c.req.query("order") ?? null).all<any>();
  return c.json({
    labels: results.map((r) => ({ ...r, tracking_numbers: JSON.parse(r.tracking_numbers), ship_to: JSON.parse(r.ship_to) })),
  });
});

function zplOf(labels: string[]): string {
  return labels.map((l) => new TextDecoder().decode(base64UrlDecodeBytes(l.replace(/\+/g, "-").replace(/\//g, "_")))).join("\n");
}

/**
 * Print-page header: prints straight away when nothing was printed before; otherwise shows what
 * was already printed (and when) and waits, with "print again" and "only the new ones" buttons.
 * The print is recorded only when it's actually sent to the printer.
 */
function printGuard(o: { what: string; markUrl: string; markIds: (string | number)[]; markBox?: number | null; already: { name: string; at: string; count: number }[]; total: number; newOnlyUrl?: string | null }) {
  const warn = o.already.length > 0;
  const list = o.already.slice(0, 12).map((a) => `<li><b>${escapeHtml(a.name)}</b> — <time data-at="${escapeHtml(a.at)}">${escapeHtml(a.at)}</time>${a.count > 1 ? ` (${a.count} times)` : ""}</li>`).join("");
  const banner = warn
    ? `<div class="guard"><div class="guard-head">⚠ ${o.already.length === o.total ? (o.total === 1 ? `This ${o.what} was already printed` : `All ${o.total} ${o.what}s were already printed`) : `${o.already.length} of ${o.total} ${o.what}s were already printed`}</div>
       <ul>${list}${o.already.length > 12 ? `<li>…and ${o.already.length - 12} more</li>` : ""}</ul>
       <div class="guard-actions"><button class="again" onclick="go()">Print ${o.total === 1 ? "it" : "all"} again</button>${o.newOnlyUrl ? `<a class="only" href="${escapeHtml(o.newOnlyUrl)}">Print only the ${o.total - o.already.length} not printed yet</a>` : ""}<button onclick="close()">Cancel</button></div></div>`
    : "";
  const script = `<script>
const MARK = ${JSON.stringify({ url: o.markUrl, ids: o.markIds, box: o.markBox ?? null })};
let marked = false;
function go() {
  if (!marked) { marked = true; fetch(MARK.url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: MARK.ids, box: MARK.box }) }).catch(() => {}); }
  document.querySelector(".guard")?.remove();
  print();
}
document.querySelectorAll("time[data-at]").forEach((t) => { t.textContent = new Date(t.dataset.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); });
${warn ? "" : "addEventListener('load', () => setTimeout(go, 300));"}
</script>`;
  return { banner, script };
}

const GUARD_CSS = `.guard { font: 14px/1.4 system-ui, sans-serif; margin: 12px; padding: 14px 16px; border-radius: 10px; background: #fff4d6; border: 2px solid #c8892b; color: #3d2a00; max-width: 520px; }
.guard-head { font-weight: 700; font-size: 16px; margin-bottom: 6px; }
.guard ul { margin: 6px 0 12px; padding-left: 20px; }
.guard-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.guard button, .guard a { font: 600 14px system-ui, sans-serif; padding: 8px 14px; border-radius: 8px; border: 1px solid #b07a20; background: #fff; color: #3d2a00; cursor: pointer; text-decoration: none; }
.guard .only { background: #213838; border-color: #213838; color: #fff; }
@media print { .guard { display: none; } }`;

function labelPage(title: string, labels: { data: string; format: string }[], guard?: ReturnType<typeof printGuard>) {
  // UPS GIF labels are landscape and get rotated onto the 4×6 page; USPS PNG labels are already 4×6 portrait
  const pages = labels
    .map((l) => (l.format === "PNG"
      ? `<div class="page"><img class="portrait" src="data:image/png;base64,${l.data}" alt="USPS label"></div>`
      : `<div class="page"><img class="landscape" src="data:image/gif;base64,${l.data}" alt="UPS label"></div>`))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: 4in 6in; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: 4in; height: 6in; overflow: hidden; position: relative; page-break-after: always; }
.page img.landscape { position: absolute; top: 0; left: 4in; width: 6in; height: 4in; transform-origin: 0 0; transform: rotate(90deg); }
.page img.portrait { width: 4in; height: 6in; object-fit: contain; display: block; }
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center; }
@media print { .bar { display: none; } }
${GUARD_CSS}
</style></head><body>
${guard?.banner ?? ""}
<div class="bar"><button onclick="${guard ? "go()" : "print()"}">Print</button> <span>${labels.length} label${labels.length === 1 ? "" : "s"} · 4×6 in, margins none, scale 100%</span></div>
${pages}
${guard?.script ?? "<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>"}
</body></html>`;
}

/** When each box of a multi-box label was printed: { "1": iso, "2": iso }. */
const printedBoxes = (r: any): Record<string, string> => {
  try { const v = JSON.parse(r.printed_boxes || "{}"); return v && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** ?box=N: just that box's label from each row (multi-box shipments printed one box at a time). */
function onlyBox(rows: any[], box: number | null) {
  if (!box) return rows;
  return rows.map((r) => {
    const all = JSON.parse(r.labels || "[]") as string[];
    const at = printedBoxes(r)[String(box)] ?? null;
    return { ...r, labels: JSON.stringify(all[box - 1] ? [all[box - 1]] : []), printed_at: at, print_count: at ? 1 : 0, order_name: `${r.order_name ?? `Label ${r.id}`} · box ${box} of ${all.length}` };
  });
}
const boxParam = (v: string | undefined) => (Number(v) > 0 && Number(v) < 100 ? Math.floor(Number(v)) : null);

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

/** Packings the app has learned (what box(es) each set of items went in). */
shipping.get("/learned", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT item_key, label, boxes, preset_id, length, width, height, weight, uses, updated_at FROM learned_parcels ORDER BY updated_at DESC LIMIT 500",
  ).all<any>();
  const presets = new Map((await c.env.DB.prepare("SELECT id, name FROM package_presets").all<{ id: number; name: string }>()).results.map((p) => [p.id, p.name]));
  return c.json({
    learned: results.map((r) => {
      const boxes = r.boxes ? JSON.parse(r.boxes) : [{ preset_id: r.preset_id, length: r.length, width: r.width, height: r.height, weight: r.weight, items: {} }];
      return {
        key: r.item_key,
        label: r.label || r.item_key.replace(/\|/g, ", ").replace(/×(\d+)/g, " × $1"),
        uses: r.uses,
        updatedAt: r.updated_at,
        boxes: boxes.map((b: any) => ({ name: (b.preset_id && presets.get(b.preset_id)) || `${b.length}×${b.width}×${b.height} in`, weight: b.weight, items: b.items ?? {} })),
      };
    }),
  });
});

shipping.delete("/learned", async (c) => {
  const key = c.req.query("key");
  if (!key) throw new HttpError(400, "Which packing?");
  await c.env.DB.prepare("DELETE FROM learned_parcels WHERE item_key = ?").bind(key).run();
  return c.json({ ok: true });
});

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
  const box = boxParam(c.req.query("box"));
  const rows = onlyBox(await labelRows(c.env, { ids: c.req.query("ids"), batch: c.req.query("batch") }), box);
  if (!rows.length) throw new HttpError(404, "No labels found");
  if (rows.every((r: any) => r.labels === "[]")) throw new HttpError(404, "These were imported from Redo — reprint them in Redo or UPS");
  const gif = rows.filter((r) => r.label_format !== "ZPL").flatMap((r) => (JSON.parse(r.labels) as string[]).map((data) => ({ data, format: r.label_format as string })));
  const zpl = rows.filter((r) => r.label_format === "ZPL").flatMap((r) => JSON.parse(r.labels) as string[]);
  if (c.req.query("format") === "zpl") return c.text(zplOf(zpl));
  if (!gif.length && zpl.length) {
    return new Response(zplOf(zpl), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="labels.zpl"` } });
  }
  const printable = rows.filter((r) => r.labels !== "[]");
  const already = printable.filter((r) => r.printed_at);
  const fresh = printable.filter((r) => !r.printed_at);
  const guard = printGuard({
    what: "label",
    markUrl: "/api/shipping/labels/printed",
    markIds: printable.map((r) => r.id),
    markBox: box,
    already: already.map((r) => ({ name: r.order_name ?? `Label ${r.id}`, at: r.printed_at, count: r.print_count })),
    total: printable.length,
    newOnlyUrl: already.length && fresh.length ? `/api/shipping/labels/print?ids=${fresh.map((r) => r.id).join(",")}` : null,
  });
  return c.html(labelPage(rows.length === 1 ? `Label ${rows[0].order_name ?? ""}` : `${rows.length} labels`, gif, guard));
});

/** For Zebra printing: which of these labels were printed before (the browser asks before resending). */
shipping.get("/labels/print-status", async (c) => {
  const rows = await labelRows(c.env, { ids: c.req.query("ids"), batch: c.req.query("batch") });
  return c.json({ labels: rows.filter((r: any) => r.labels !== "[]").map((r: any) => ({ id: r.id, name: r.order_name, printedAt: r.printed_at, count: r.print_count })) });
});

/** For Zebra printing: every label in the selection (ZPL as text, images as base64) and whether it was printed before. */
shipping.get("/labels/print-data", async (c) => {
  const rows = onlyBox(await labelRows(c.env, { ids: c.req.query("ids"), batch: c.req.query("batch") }), boxParam(c.req.query("box")));
  return c.json({
    labels: rows.filter((r: any) => r.labels !== "[]").map((r: any) => {
      const data = JSON.parse(r.labels) as string[];
      return { id: r.id, name: r.order_name, format: r.label_format, data: r.label_format === "ZPL" ? data.map((l) => zplOf([l])) : data, printedAt: r.printed_at, count: r.print_count };
    }),
  });
});

shipping.post("/labels/printed", async (c) => {
  const { ids, box } = await c.req.json<{ ids: number[]; box?: number }>();
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => n > 0).slice(0, 200);
  const n = boxParam(String(box ?? ""));
  if (list.length && n) {
    // One box of a multi-box label: remember that box (and that something of it was printed)
    await c.env.DB.prepare(
      `UPDATE shipments SET printed_boxes = json_set(CASE WHEN json_valid(printed_boxes) AND json_type(printed_boxes) = 'object' THEN printed_boxes ELSE '{}' END, '$."' || ? || '"', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         printed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), print_count = print_count + 1 WHERE id IN (${list.map(() => "?").join(",")})`,
    ).bind(String(n), ...list).run();
  } else if (list.length) {
    await c.env.DB.prepare(`UPDATE shipments SET printed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), print_count = print_count + 1 WHERE id IN (${list.map(() => "?").join(",")})`).bind(...list).run();
  }
  return c.json({ ok: true });
});

/** Printable label page (GIF) or raw ZPL for thermal printers. */
shipping.get("/labels/:id{[0-9]+}/print", async (c) => {
  const s = await c.env.DB.prepare("SELECT id, labels, label_format, tracking_numbers, order_name, printed_at, print_count FROM shipments WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ id: number; labels: string; label_format: string; tracking_numbers: string; order_name: string | null; printed_at: string | null; print_count: number }>();
  if (!s) throw new HttpError(404, "Label not found");
  const labels: string[] = JSON.parse(s.labels);
  if (!labels.length) throw new HttpError(404, "Imported from Redo — reprint it in Redo or UPS");
  if (s.label_format === "ZPL") {
    if (c.req.query("format") === "zpl") return c.text(zplOf(labels));
    return new Response(zplOf(labels), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="ups-${JSON.parse(s.tracking_numbers)[0]}.zpl"` },
    });
  }
  const guard = printGuard({
    what: "label", markUrl: "/api/shipping/labels/printed", markIds: [s.id], total: 1,
    already: s.printed_at ? [{ name: s.order_name ?? `Label ${s.id}`, at: s.printed_at, count: s.print_count }] : [],
  });
  return c.html(labelPage(`Label ${s.order_name ?? ""}`, labels.map((data) => ({ data, format: s.label_format })), guard));
});

shipping.post("/labels/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const s = await c.env.DB.prepare("SELECT shipment_id, status, carrier, order_id, fulfilled, fulfillment_id, tracking_numbers FROM shipments WHERE id = ?").bind(id)
    .first<{ shipment_id: string; status: string; carrier: string | null; order_id: string | null; fulfilled: number; fulfillment_id: string | null; tracking_numbers: string }>();
  if (!s) throw new HttpError(404, "Label not found");
  if (s.status === "voided") return c.json({ ok: true, already: true });
  if (!s.shipment_id) throw new HttpError(409, "Imported from Redo — void it in Redo or UPS");
  // 1. The carrier: UPS cancels it (no charge); USPS starts a refund (paid back to the EasyPost wallet in ~2–4 weeks)
  await voidLabel(c.env, s.shipment_id);
  await c.env.DB.prepare("UPDATE shipments SET status = 'voided', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id).run();
  // 2. Shopify: undo the fulfillment so the order can be shipped again
  let shopify: "cancelled" | "not_found" | "skipped" | string = "skipped";
  if (s.order_id && s.fulfilled && !demo(c.env)) {
    try {
      shopify = (await cancelFulfillment(c.env, s.order_id, s.fulfillment_id, JSON.parse(s.tracking_numbers || "[]"))) ? "cancelled" : "not_found";
      if (shopify === "cancelled") await c.env.DB.prepare("UPDATE shipments SET fulfilled = 0 WHERE id = ?").bind(id).run();
    } catch (e) {
      shopify = (e as Error).message;
    }
  }
  return c.json({ ok: true, carrier: s.carrier ?? (s.shipment_id.startsWith("ep:") ? "USPS" : "UPS"), refund: s.shipment_id.startsWith("ep:") ? "requested" : "voided", shopify });
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

// ---- Packing slips (layout from Settings → Packing slip)

/**
 * The slips to print for each order: one per box when it ships in several. Once a label is bought
 * the boxes (and their tracking numbers) come from that shipment; before that, from the boxes
 * chosen on the order page or remembered for these items.
 */
/** Slips for one shipment (e.g. a partial one): one per box, listing what that box holds. */
async function slipsForShipment(env: Env, shipmentId: number): Promise<{ order: Described; box?: SlipBox }[]> {
  const s = await env.DB.prepare("SELECT order_id, packages, tracking_numbers, partial FROM shipments WHERE id = ?").bind(shipmentId)
    .first<{ order_id: string | null; packages: string; tracking_numbers: string; partial: number }>();
  if (!s?.order_id) throw new HttpError(404, "Shipment not found");
  const found = demo(env) ? demoOrders().find((o) => o.id === s.order_id) : await getOrder(env, s.order_id);
  if (!found) throw new HttpError(404, "Order not found");
  // The whole order (not just what's left): the shipment's own lines say what went in it
  const [order] = await describe(env, [{ ...found, lineItems: { ...found.lineItems, nodes: found.lineItems.nodes.map((l) => ({ ...l, unfulfilledQuantity: undefined })) } }]);
  const pk = JSON.parse(s.packages || "[]") as { box?: string; contents?: { id: string; qty: number }[] }[];
  const tn = JSON.parse(s.tracking_numbers || "[]") as string[];
  const boxes = pk.filter((p) => p.contents?.length).map((p, i) => ({ name: p.box ?? null, tracking: tn[i] ?? null, qty: Object.fromEntries(p.contents!.map((x) => [x.id, x.qty])) }));
  if (!boxes.length) return [{ order }];
  if (boxes.length === 1) return [{ order: { ...order, lineItems: { ...order.lineItems, nodes: order.lineItems.nodes.filter((l) => boxes[0].qty[l.id]).map((l) => ({ ...l, quantity: boxes[0].qty[l.id] })) } } }];
  return boxes.map((b, i) => ({ order, box: { ...b, n: i + 1, of: boxes.length } }));
}

async function slipsFor(env: Env, orders: Described[]): Promise<{ order: Described; box?: SlipBox }[]> {
  const ids = orders.map((o) => o.id);
  const bought = new Map<string, { packages: string; tracking_numbers: string }>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(
      `SELECT order_id, packages, tracking_numbers FROM shipments WHERE status = 'purchased' AND COALESCE(partial, 0) = 0 AND order_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`,
    ).bind(...chunk).all<{ order_id: string; packages: string; tracking_numbers: string }>();
    for (const r of results) bought.set(r.order_id, r); // the latest shipment wins
  }
  const out: { order: Described; box?: SlipBox }[] = [];
  for (const o of orders) {
    const s = bought.get(o.id);
    let boxes: { name: string | null; tracking: string | null; qty: Record<string, number> }[] = [];
    if (s) {
      const pk = JSON.parse(s.packages || "[]") as { box?: string; contents?: { id: string; qty: number }[] }[];
      const tn = JSON.parse(s.tracking_numbers || "[]") as string[];
      if (pk.length > 1 && pk.every((p) => p.contents)) {
        boxes = pk.map((p, i) => ({ name: p.box ?? null, tracking: tn[i] ?? null, qty: Object.fromEntries(p.contents!.map((x) => [x.id, x.qty])) }));
      }
    } else if (o.plan.boxes.length > 1) {
      boxes = o.plan.boxes.map((b) => ({ name: b.preset?.name ?? null, tracking: null, qty: b.items }));
    }
    const filled = boxes.filter((b) => Object.values(b.qty).some((q) => q > 0));
    if (filled.length > 1) filled.forEach((b, i) => out.push({ order: o, box: { ...b, n: i + 1, of: filled.length } }));
    else out.push({ order: o });
  }
  return out;
}
const slipPage = (body: string, count: number, size: "4x6" | "letter", autoPrint: boolean, guard?: ReturnType<typeof printGuard>) => `<!doctype html><html><head><meta charset="utf-8"><title>Packing slips</title><style>
@page { size: ${size === "letter" ? "8.5in 11in" : "4in 6in"}; }
${SLIP_CSS}
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center; }
@media print { .bar { display: none; } }
${GUARD_CSS}
</style></head><body>
${guard?.banner ?? ""}
${autoPrint ? `<div class="bar"><button onclick="${guard ? "go()" : "print()"}">Print</button><span>${count} packing slip${count === 1 ? "" : "s"} · ${size === "letter" ? "Letter" : "4×6"}</span></div>` : ""}
${body}
${autoPrint ? guard?.script ?? "<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>" : ""}
</body></html>`;

shipping.get("/slip-layout", async (c) => c.json({ layout: await slipLayout(c.env) }));

shipping.put("/slip-layout", async (c) => {
  requireAdmin(c);
  const layout = cleanSlip((await c.req.json<{ layout: unknown }>()).layout);
  await setSetting(c.env, "slip_layout", layout);
  return c.json({ layout });
});

/** Live preview for the settings screen: an unsaved layout on a sample (or a given) order. */
shipping.post("/packing-slips/preview", async (c) => {
  const body = await c.req.json<{ layout: unknown; size?: string; orderId?: string }>();
  const size = body.size === "letter" ? "letter" : "4x6";
  let order: ShopifyOrder | undefined;
  if (body.orderId && !demo(c.env)) order = (await ordersByIds(c.env, [body.orderId]))[0];
  order ??= [...demoOrders()].sort((x, y) => y.lineItems.nodes.length - x.lineItems.nodes.length)[0];
  const [described] = await describe(c.env, [order]);
  const from = await getSetting<Address | null>(c.env, "ship_from", null);
  return c.html(slipPage(renderSlip(described, size, from, cleanSlip(body.layout)), 1, size, false));
});

shipping.post("/packing-slips/printed", async (c) => {
  const { ids } = await c.req.json<{ ids: string[] }>();
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x.startsWith("gid://")).slice(0, 100);
  if (list.length) {
    await c.env.DB.batch(list.map((id) => c.env.DB.prepare(
      `INSERT INTO packing_slip_prints (order_id, printed_at, print_count) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1)
       ON CONFLICT(order_id) DO UPDATE SET printed_at = excluded.printed_at, print_count = print_count + 1`,
    ).bind(id)));
  }
  return c.json({ ok: true });
});

/**
 * Slips for printing straight to a Zebra: the HTML of each slip (product photos inlined so the
 * browser can draw them) plus which were printed before. The browser turns each into ZPL.
 */
shipping.get("/packing-slips/data", async (c) => {
  const shipmentId = Number(c.req.query("shipment")) || 0; // one shipment's slips (e.g. a partial one)
  const forShipment = shipmentId ? await slipsForShipment(c.env, shipmentId) : null;
  const ids = forShipment ? [forShipment[0].order.id] : (c.req.query("ids") ?? "").split(",").map(decodeURIComponent).filter((s) => s.startsWith("gid://")).slice(0, 50);
  if (!ids.length) throw new HttpError(400, "No orders selected");
  const described = forShipment ? forShipment.map((x) => x.order) : await describe(c.env, demo(c.env) ? demoOrders().filter((o) => ids.includes(o.id)) : await ordersByIds(c.env, ids));
  const from = await getSetting<Address | null>(c.env, "ship_from", null);
  const layout = await slipLayout(c.env);
  if (layout.itemImages) {
    const urls = [...new Set(described.flatMap((o) => o.lineItems.nodes.map((l) => l.image?.url).filter((u): u is string => !!u && !u.startsWith("data:"))))].slice(0, 25);
    const inlined = new Map<string, string>();
    await Promise.all(urls.map(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return;
        const type = r.headers.get("content-type") ?? "image/jpeg";
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length > 400_000) return;
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        inlined.set(u, `data:${type};base64,${btoa(bin)}`);
      } catch { /* that photo is left blank */ }
    }));
    for (const o of described) for (const l of o.lineItems.nodes) if (l.image?.url) l.image = { ...l.image, url: inlined.get(l.image.url) ?? "" };
  }
  const prints = await idMap(c.env, "SELECT order_id, printed_at || '|' || print_count AS v FROM packing_slip_prints WHERE order_id IN (?)", described.map((o) => o.id));
  return c.json({
    css: SLIP_CSS,
    slips: (forShipment ?? (await slipsFor(c.env, described))).map(({ order: o, box }) => ({ id: o.id, name: box ? `${o.name} (box ${box.n} of ${box.of})` : o.name, html: renderSlip(o, "4x6", from, layout, box) })),
    printed: described.filter((o) => prints.has(o.id)).map((o) => { const [at, n] = prints.get(o.id)!.split("|"); return { id: o.id, name: o.name, at, count: Number(n) || 1 }; }),
  });
});

shipping.get("/packing-slips", async (c) => {
  const shipmentId = Number(c.req.query("shipment")) || 0;
  const forShipment = shipmentId ? await slipsForShipment(c.env, shipmentId) : null;
  const ids = forShipment ? [forShipment[0].order.id] : (c.req.query("ids") ?? "").split(",").map(decodeURIComponent).filter((s) => s.startsWith("gid://")).slice(0, 100);
  if (!ids.length) throw new HttpError(400, "No orders selected");
  const size = c.req.query("size") === "letter" ? "letter" : "4x6";
  const described = forShipment ? [forShipment[0].order] : await describe(c.env, demo(c.env) ? demoOrders().filter((o) => ids.includes(o.id)) : await ordersByIds(c.env, ids));
  const from = await getSetting<Address | null>(c.env, "ship_from", null);
  const layout = await slipLayout(c.env);
  const prints = await idMap(c.env, "SELECT order_id, printed_at || '|' || print_count AS v FROM packing_slip_prints WHERE order_id IN (?)", described.map((o) => o.id));
  const already = described.filter((o) => prints.has(o.id));
  const fresh = described.filter((o) => !prints.has(o.id));
  const guard = printGuard({
    what: "packing slip",
    markUrl: "/api/shipping/packing-slips/printed",
    markIds: described.map((o) => o.id),
    already: already.map((o) => { const [at, n] = prints.get(o.id)!.split("|"); return { name: o.name, at, count: Number(n) || 1 }; }),
    total: described.length,
    newOnlyUrl: already.length && fresh.length ? `/api/shipping/packing-slips?size=${size}&ids=${fresh.map((o) => encodeURIComponent(o.id)).join(",")}` : null,
  });
  const slips = forShipment ?? (await slipsFor(c.env, described));
  return c.html(slipPage(slips.map(({ order: o, box }) => renderSlip(o, size, from, layout, box)).join(""), slips.length, size, true, guard));
});

export default shipping;

// ---- Ship-from phone, added from the order page when a label can't be bought without it
shipping.post("/ship-from/phone", async (c) => {
  requireAdmin(c);
  const { phone } = await c.req.json<{ phone?: string }>();
  const from = await getSetting<Address | null>(c.env, "ship_from", null);
  if (!from?.address1) throw new HttpError(409, "Add your ship-from address in Settings → Shipping first");
  const clean = normalizePhone(phone, from.country);
  if (clean.length < 10) throw new HttpError(400, "That doesn't look like a full phone number (10 digits with the area code)");
  await setSetting(c.env, "ship_from", { ...from, phone: clean });
  return c.json({ ok: true, phone: clean });
});
