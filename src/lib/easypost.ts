// USPS through EasyPost (EasyPost's own USPS account, paid from the EasyPost wallet).
// One box = one EasyPost shipment; several boxes = an EasyPost order (one label per box).
import type { Env } from "../env";
import type { Address, Parcel, Rate, ShipResult, Signature } from "./ups";
import { HttpError } from "./util";
import type { Customs, CustomsItem } from "./customs";

const API = "https://api.easypost.com/v2";

export const USPS_SERVICES: Record<string, string> = {
  FirstClassPackageInternationalService: "USPS First-Class Package International",
  PriorityMailInternational: "USPS Priority Mail International",
  ExpressMailInternational: "USPS Priority Mail Express International",
  GroundAdvantage: "USPS Ground Advantage",
  Priority: "USPS Priority Mail",
  Express: "USPS Priority Mail Express",
  ParcelSelect: "USPS Parcel Select",
  MediaMail: "USPS Media Mail",
  LibraryMail: "USPS Library Mail",
};
export const isUspsCode = (code: string) => code.startsWith("usps:");
export const easypostConfigured = (env: Env) => !!env.EASYPOST_API_KEY;

async function ep<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.EASYPOST_API_KEY) throw new HttpError(409, "Add your EasyPost API key in Settings → Credentials → USPS");
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Basic ${btoa(`${env.EASYPOST_API_KEY}:`)}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message ?? `${res.status}`;
    const detail = (json?.error?.errors ?? []).map((e: any) => e.message ?? e).filter(Boolean).join("; ");
    throw new HttpError(res.status === 401 ? 502 : 422, `USPS (EasyPost): ${msg}${detail ? ` — ${detail}` : ""}`);
  }
  return json as T;
}

const address = (a: Address) => ({
  name: a.name || undefined,
  company: a.company || undefined,
  street1: a.address1,
  street2: a.address2 || undefined,
  city: a.city,
  state: a.state,
  zip: a.zip,
  country: a.country || "US",
  phone: a.phone || undefined,
  email: a.email || undefined,
  residential: a.residential ?? undefined,
});

const parcel = (p: Parcel) => ({
  length: Math.max(1, p.length),
  width: Math.max(1, p.width),
  height: Math.max(0.25, p.height || 0.25),
  weight: Math.max(0.1, Math.round(p.weight * 16 * 10) / 10), // ounces
});

const options = (signature: Signature, labelFormat: "GIF" | "ZPL", reference?: string) => ({
  label_format: labelFormat === "ZPL" ? "ZPL" : "PNG",
  label_size: "4x6",
  ...(signature === "adult" ? { delivery_confirmation: "ADULT_SIGNATURE" } : signature === "standard" ? { delivery_confirmation: "SIGNATURE" } : {}),
  ...(reference ? { print_custom_1: reference.slice(0, 35) } : {}),
});

function toRates(raw: any[]): Rate[] {
  return (raw ?? [])
    .filter((r) => r.carrier === "USPS" && USPS_SERVICES[r.service])
    .map((r) => ({
      carrier: "USPS",
      serviceCode: `usps:${r.service}`,
      serviceName: USPS_SERVICES[r.service],
      total: Number(r.rate),
      listTotal: Number(r.retail_rate ?? r.list_rate ?? r.rate),
      currency: r.currency ?? "USD",
      days: r.delivery_days ?? r.est_delivery_days ?? null,
    }))
    .sort((a, b) => a.total - b.total);
}

const domestic = (to: Address) => (to.country || "US").toUpperCase() === "US";

/** EasyPost customs_info for one box: the box's own items when the order is split, else every item. */
function customsInfo(c: Customs, p: Parcel, boxes: number) {
  let items: CustomsItem[] = c.items;
  if (boxes > 1 && p.contents?.length) {
    const byLine = new Map(c.items.map((i) => [i.lineId, i]));
    items = p.contents.map((x) => ({ ...(byLine.get(x.id) ?? c.items[0]), qty: x.qty })).filter((i) => i && i.qty > 0);
  } else if (boxes > 1) {
    throw new HttpError(422, "Split orders going abroad need each box's items assigned (What goes in each box)");
  }
  return {
    contents_type: c.contents,
    customs_certify: true,
    customs_signer: c.signer || undefined,
    eel_pfc: "NOEEI 30.37(a)",
    non_delivery_option: c.nonDelivery,
    restriction_type: "none",
    customs_items: items.map((i) => ({
      description: i.description,
      quantity: i.qty,
      value: Math.round(i.qty * i.unitValue * 100) / 100,
      weight: Math.max(0.1, Math.round(i.qty * i.unitWeightLb * 16 * 10) / 10),
      hs_tariff_number: i.hsCode || undefined,
      origin_country: i.origin || "US",
      currency: "USD",
    })),
  };
}

async function create(env: Env, from: Address, to: Address, parcels: Parcel[], signature: Signature, labelFormat: "GIF" | "ZPL", reference?: string, customs?: Customs) {
  const intl = !domestic(to);
  if (intl && !customs) throw new HttpError(422, "International shipments need customs details");
  const opts = options(intl ? undefined : signature, labelFormat, reference);
  const ci = (p: Parcel) => (intl ? { customs_info: customsInfo(customs!, p, parcels.length) } : {});
  if (parcels.length === 1) {
    const s = await ep(env, "POST", "/shipments", { shipment: { to_address: address(to), from_address: address(from), parcel: parcel(parcels[0]), options: opts, reference, ...ci(parcels[0]) } });
    return { kind: "shipment" as const, id: s.id as string, rates: s.rates as any[] };
  }
  const o = await ep(env, "POST", "/orders", {
    order: { to_address: address(to), from_address: address(from), reference, options: opts, shipments: parcels.map((p) => ({ parcel: parcel(p), options: opts, ...ci(p) })) },
  });
  return { kind: "order" as const, id: o.id as string, rates: o.rates as any[] };
}

export async function getUspsRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs): Promise<Rate[]> {
  if (!domestic(to) && !customs) return []; // can't quote abroad without a customs list
  const c = await create(env, from, to, parcels, signature, "GIF", undefined, customs);
  return toRates(c.rates);
}

async function download(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(502, `Couldn't download the USPS label (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Buys a USPS label (or one per box). shipmentId is stored as "ep:<id>,<id>" for refunds. */
export async function buyUsps(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; signature?: Signature; customs?: Customs },
): Promise<ShipResult & { format: "PNG" | "ZPL" }> {
  const service = serviceCode.replace(/^usps:/, "");
  const c = await create(env, from, to, parcels, opts.signature, opts.labelFormat, opts.reference, opts.customs);
  const shipments: any[] = [];
  if (c.kind === "shipment") {
    const rate = c.rates.find((r) => r.carrier === "USPS" && r.service === service);
    if (!rate) throw new HttpError(422, `${USPS_SERVICES[service] ?? service} isn't available for this package`);
    shipments.push(await ep(env, "POST", `/shipments/${c.id}/buy`, { rate: { id: rate.id } }));
  } else {
    const o = await ep(env, "POST", `/orders/${c.id}/buy`, { carrier: "USPS", service });
    shipments.push(...(o.shipments ?? []));
  }
  const zpl = opts.labelFormat === "ZPL";
  const labels: string[] = [];
  for (const s of shipments) {
    const url = zpl ? s.postage_label?.label_zpl_url ?? s.postage_label?.label_url : s.postage_label?.label_url;
    if (url) labels.push(await download(url));
  }
  // Customs paperwork (commercial invoice / CN23) when USPS doesn't print it on the label itself
  const forms: { type: string; data: string }[] = [];
  for (const s of shipments) {
    for (const f of s.forms ?? []) {
      if (f?.form_url) forms.push({ type: String(f.form_type ?? "Customs form").replace(/_/g, " "), data: await download(f.form_url) });
    }
  }
  return {
    forms,
    shipmentId: `ep:${shipments.map((s) => s.id).join(",")}`,
    trackingNumbers: shipments.map((s) => s.tracking_code).filter(Boolean),
    labels,
    cost: Math.round(shipments.reduce((n, s) => n + Number(s.selected_rate?.rate ?? 0), 0) * 100) / 100,
    currency: shipments[0]?.selected_rate?.currency ?? "USD",
    format: zpl ? "ZPL" : "PNG",
  };
}

/** Asks USPS for a refund of every label in the shipment (USPS refunds take a couple of weeks). */
export async function refundUsps(env: Env, shipmentId: string) {
  for (const id of shipmentId.replace(/^ep:/, "").split(",").filter(Boolean)) {
    await ep(env, "POST", `/shipments/${id}/refund`);
  }
}

export async function testEasypost(env: Env) {
  await ep(env, "GET", "/shipments?page_size=1");
}

export const uspsTrackingUrl = (n: string) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`;

/** EasyPost delivery verification (about 2¢ when used on its own). Used when UPS isn't available. */
export async function verifyAddressEasypost(env: Env, a: Address): Promise<import("./ups").AddressCheck> {
  const { sameAddress } = await import("./ups");
  const r = await ep(env, "POST", "/addresses", { verify: ["delivery"], address: address(a) });
  const v = r?.verifications?.delivery;
  if (!v?.success) {
    return { status: "invalid", residential: null, suggestion: null, provider: "EasyPost", message: v?.errors?.[0]?.message ?? "This address couldn't be verified" };
  }
  const fixed: Address = {
    ...a,
    address1: r.street1 ?? a.address1,
    address2: r.street2 ?? a.address2,
    city: r.city ?? a.city,
    state: r.state ?? a.state,
    zip: r.zip ?? a.zip,
    country: r.country ?? a.country,
  };
  const same = sameAddress(a, fixed);
  return {
    status: same ? "valid" : "corrected",
    residential: typeof r.residential === "boolean" ? r.residential : null,
    suggestion: same ? null : fixed,
    provider: "EasyPost",
    message: same ? "Verified" : "Suggested correction",
  };
}
