import { Hono } from "hono";
import type { AppEnv } from "../env";
import { fulfillOrder, getOrder, searchOrders, shopifyConfigured } from "../lib/shopify";
import { createShipment, getRates, trackingUrl, upsConfigured, voidShipment, type Address, type Parcel } from "../lib/ups";
import { HttpError, base64UrlDecodeBytes, getSetting } from "../lib/util";
import { demoOrders } from "../lib/demo";

const shipping = new Hono<AppEnv>();

export async function shipFrom(env: AppEnv["Bindings"]): Promise<Address> {
  const a = await getSetting<Address | null>(env, "ship_from", null);
  if (!a?.address1) throw new HttpError(409, "Add your ship-from address in Settings → Shipping first");
  return a;
}

function validParcels(parcels: Parcel[]): Parcel[] {
  if (!Array.isArray(parcels) || !parcels.length) throw new HttpError(400, "Add at least one package");
  return parcels.map((p, i) => {
    const n = { length: +p.length, width: +p.width, height: +p.height, weight: +p.weight };
    if (Object.values(n).some((v) => !(v > 0))) throw new HttpError(400, `Package ${i + 1} needs dimensions and a weight`);
    return n;
  });
}

function validAddress(a: Address): Address {
  for (const k of ["name", "address1", "city", "state", "zip", "country"] as const) {
    if (!a?.[k]?.toString().trim()) throw new HttpError(400, `Ship-to address is missing ${k}`);
  }
  return a;
}

shipping.get("/status", (c) => c.json({ ups: upsConfigured(c.env), shopify: shopifyConfigured(c.env), upsEnv: c.env.UPS_ENV }));

shipping.get("/orders", async (c) => {
  const orders = !shopifyConfigured(c.env) && c.env.DEMO_DATA === "1" ? demoOrders() : await searchOrders(c.env, c.req.query("q") ?? "");
  // Mark which orders already have a label from this app
  const ids = orders.map((o) => o.id);
  const labelled = new Set<string>();
  if (ids.length) {
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT order_id FROM shipments WHERE status = 'purchased' AND order_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ order_id: string }>();
    results.forEach((r) => labelled.add(r.order_id));
  }
  return c.json({ orders: orders.map((o) => ({ ...o, hasLabel: labelled.has(o.id) })) });
});

shipping.get("/orders/:id", async (c) => {
  const order = await getOrder(c.env, decodeURIComponent(c.req.param("id")));
  return c.json({ order });
});

shipping.get("/presets", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM package_presets ORDER BY name").all();
  return c.json({ presets: results });
});

shipping.post("/presets", async (c) => {
  const p = await c.req.json<{ name: string; length: number; width: number; height: number; weight: number }>();
  if (!p.name?.trim()) throw new HttpError(400, "Name the box");
  const [v] = validParcels([{ ...p, weight: p.weight || 0.01 }]);
  await c.env.DB.prepare("INSERT INTO package_presets (name, length, width, height, weight) VALUES (?, ?, ?, ?, ?)")
    .bind(p.name.trim(), v.length, v.width, v.height, +p.weight || 0)
    .run();
  return c.json({ ok: true });
});

shipping.delete("/presets/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM package_presets WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

shipping.post("/rates", async (c) => {
  const body = await c.req.json<{ to: Address; parcels: Parcel[] }>();
  const rates = await getRates(c.env, await shipFrom(c.env), validAddress(body.to), validParcels(body.parcels));
  return c.json({ rates });
});

shipping.post("/labels", async (c) => {
  const me = c.get("agent");
  const body = await c.req.json<{
    orderId?: string;
    orderName?: string;
    ticketId?: number;
    to: Address;
    parcels: Parcel[];
    serviceCode: string;
    serviceName: string;
    labelFormat?: "GIF" | "ZPL";
    fulfill?: boolean;
    notifyCustomer?: boolean;
  }>();
  const parcels = validParcels(body.parcels);
  const to = validAddress(body.to);
  const labelFormat = body.labelFormat === "ZPL" ? "ZPL" : "GIF";
  const result = await createShipment(c.env, await shipFrom(c.env), to, parcels, body.serviceCode, {
    reference: body.orderName,
    labelFormat,
  });

  const row = await c.env.DB.prepare(
    `INSERT INTO shipments (order_id, order_name, ticket_id, service_code, service_name, shipment_id, tracking_numbers, labels, label_format, cost, currency, packages, ship_to, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      body.orderId ?? null,
      body.orderName ?? null,
      body.ticketId ?? null,
      body.serviceCode,
      body.serviceName,
      result.shipmentId,
      JSON.stringify(result.trackingNumbers),
      JSON.stringify(result.labels),
      labelFormat,
      result.cost,
      result.currency,
      JSON.stringify(parcels),
      JSON.stringify(to),
      me.id,
    )
    .first<{ id: number }>();

  let fulfillError: string | null = null;
  if (body.fulfill && body.orderId && result.trackingNumbers[0]) {
    try {
      await fulfillOrder(
        c.env,
        body.orderId,
        { company: "UPS", number: result.trackingNumbers[0], url: trackingUrl(result.trackingNumbers[0]) },
        body.notifyCustomer ?? true,
      );
      await c.env.DB.prepare("UPDATE shipments SET fulfilled = 1 WHERE id = ?").bind(row!.id).run();
    } catch (e) {
      fulfillError = (e as Error).message;
    }
  }
  return c.json({ id: row!.id, ...result, labels: undefined, fulfillError });
});

shipping.get("/labels", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.order_id, s.order_name, s.service_name, s.tracking_numbers, s.cost, s.currency, s.status, s.fulfilled,
            s.label_format, s.ship_to, s.created_at, a.name AS agent_name
     FROM shipments s LEFT JOIN agents a ON a.id = s.agent_id ORDER BY s.created_at DESC LIMIT 100`,
  ).all<any>();
  return c.json({
    labels: results.map((r) => ({ ...r, tracking_numbers: JSON.parse(r.tracking_numbers), ship_to: JSON.parse(r.ship_to) })),
  });
});

/** Printable label page (GIF) or raw ZPL for thermal printers. */
shipping.get("/labels/:id{[0-9]+}/print", async (c) => {
  const s = await c.env.DB.prepare("SELECT labels, label_format, tracking_numbers, order_name FROM shipments WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ labels: string; label_format: string; tracking_numbers: string; order_name: string | null }>();
  if (!s) throw new HttpError(404, "Label not found");
  const labels: string[] = JSON.parse(s.labels);
  if (s.label_format === "ZPL") {
    const zpl = labels.map((l) => new TextDecoder().decode(base64UrlDecodeBytes(l.replace(/\+/g, "-").replace(/\//g, "_")))).join("\n");
    return new Response(zpl, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="ups-${JSON.parse(s.tracking_numbers)[0]}.zpl"`,
      },
    });
  }
  // UPS GIF labels are landscape; rotate onto a 4×6 page
  const pages = labels
    .map((l) => `<div class="page"><img src="data:image/gif;base64,${l}" alt="UPS label"></div>`)
    .join("");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Label ${s.order_name ?? ""}</title>
<style>
@page { size: 4in 6in; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.page { width: 4in; height: 6in; overflow: hidden; position: relative; page-break-after: always; }
.page img { position: absolute; top: 0; left: 4in; width: 6in; height: 4in; transform-origin: 0 0; transform: rotate(90deg); }
.bar { font: 14px system-ui, sans-serif; padding: 12px; display: flex; gap: 8px; align-items: center; }
@media print { .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="print()">Print</button> <span>4×6 label · set paper to 4×6 in, margins none, scale 100%</span></div>
${pages}
<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>
</body></html>`);
});

shipping.post("/labels/:id{[0-9]+}/void", async (c) => {
  const id = Number(c.req.param("id"));
  const s = await c.env.DB.prepare("SELECT shipment_id, status FROM shipments WHERE id = ?").bind(id).first<{ shipment_id: string; status: string }>();
  if (!s) throw new HttpError(404, "Label not found");
  if (s.status === "voided") return c.json({ ok: true });
  await voidShipment(c.env, s.shipment_id);
  await c.env.DB.prepare("UPDATE shipments SET status = 'voided' WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default shipping;
