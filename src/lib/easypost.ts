// EasyPost: USPS (EasyPost's own account) plus every other carrier turned on in EasyPost
// (UPS, FedEx, OnTrac, Amazon Shipping, DHL eCommerce…), all paid from the EasyPost wallet.
// One box = one EasyPost shipment; several boxes = an EasyPost order (one label per box).
// Service codes: "usps:<service>" for USPS, "ep:<EasyPost carrier>:<service>" for the rest.
import type { Env } from "../env";
import { normalizePhone, splitCost, type Address, type Parcel, type Rate, type ShipResult, type Signature } from "./ups";
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
export const isEasypostCode = (code: string) => isUspsCode(code) || code.startsWith("ep:");

/** EasyPost's carrier ids → the names people (and Shopify) know. */
const CARRIER_NAMES: Record<string, string> = {
  USPS: "USPS",
  UPS: "UPS",
  UPSDAP: "UPS",
  UPSSurePost: "UPS",
  FedEx: "FedEx",
  FedExDefault: "FedEx",
  FedExSmartPost: "FedEx",
  OnTrac: "OnTrac",
  AmazonShipping: "Amazon Shipping",
  DhlEcs: "DHL eCommerce",
  DHLEcommerce: "DHL eCommerce",
  DHLExpress: "DHL Express",
  CanadaPost: "Canada Post",
  LSO: "LSO",
  Veho: "Veho",
  GSO: "GLS",
  Passport: "Passport",
};
export const carrierName = (raw: string) => CARRIER_NAMES[raw] ?? raw.replace(/([a-z])([A-Z])/g, "$1 $2");

const SERVICE_NAMES: Record<string, string> = {
  "UPS:Ground": "Ground",
  "UPS:UPSStandard": "Standard",
  "UPS:3DaySelect": "3 Day Select",
  "UPS:2ndDayAir": "2nd Day Air",
  "UPS:2ndDayAirAM": "2nd Day Air A.M.",
  "UPS:NextDayAir": "Next Day Air",
  "UPS:NextDayAirSaver": "Next Day Air Saver",
  "UPS:NextDayAirEarlyAM": "Next Day Air Early",
  "UPS:UPSSaver": "Worldwide Saver",
  "UPS:Expedited": "Worldwide Expedited",
  "UPS:Express": "Worldwide Express",
  "UPS:UPSGroundsaver": "Ground Saver",
  "UPS:GroundSaver": "Ground Saver",
  "FedEx:FEDEX_GROUND": "Ground",
  "FedEx:GROUND_HOME_DELIVERY": "Home Delivery",
  "FedEx:SMART_POST": "Ground Economy",
  "FedEx:FEDEX_2_DAY": "2Day",
  "FedEx:FEDEX_2_DAY_AM": "2Day A.M.",
  "FedEx:FEDEX_EXPRESS_SAVER": "Express Saver",
  "FedEx:STANDARD_OVERNIGHT": "Standard Overnight",
  "FedEx:PRIORITY_OVERNIGHT": "Priority Overnight",
  "FedEx:FIRST_OVERNIGHT": "First Overnight",
  "FedEx:INTERNATIONAL_ECONOMY": "International Economy",
  "FedEx:INTERNATIONAL_PRIORITY": "International Priority",
  "OnTrac:GRND": "Ground",
  "DHL eCommerce:DHLParcelExpedited": "Parcel Expedited",
  "DHL eCommerce:DHLParcelExpeditedMax": "Parcel Expedited Max",
  "DHL eCommerce:DHLParcelGround": "Parcel Ground",
  "DHL eCommerce:DHLSMParcelsExpedited": "SM Parcel Expedited",
  "DHL eCommerce:DHLSMParcelsExpeditedMax": "SM Parcel Expedited Max",
  "DHL eCommerce:DHLSMParcelsGround": "SM Parcel Ground",
};

/** "FedEx" + "FEDEX_GROUND" → "FedEx Ground"; unknown services are spelled out from their code. */
export function easypostServiceName(rawCarrier: string, service: string): string {
  if (rawCarrier === "USPS" && USPS_SERVICES[service]) return USPS_SERVICES[service];
  const carrier = carrierName(rawCarrier);
  const known = SERVICE_NAMES[`${carrier}:${service}`];
  let name = known ?? service
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .map((w) => (/^(AM|PM|SM|DHL|UPS|USPS)$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
  const first = carrier.split(" ")[0].toLowerCase();
  if (name.toLowerCase().startsWith(first)) name = name.slice(first.length).trim();
  return `${carrier} ${name}`.trim();
}

/** "ep:FedEx:FEDEX_GROUND" → { raw: "FedEx", service: "FEDEX_GROUND" }; "usps:Priority" → USPS. */
export function parseEasypostCode(code: string): { raw: string; service: string } {
  if (isUspsCode(code)) return { raw: "USPS", service: code.slice(5) };
  const [, raw = "", ...rest] = code.split(":");
  return { raw, service: rest.join(":") };
}
const codeFor = (raw: string, service: string) => (raw === "USPS" ? `usps:${service}` : `ep:${raw}:${service}`);
export const easypostConfigured = (env: Env) => !!env.EASYPOST_API_KEY;

async function ep<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.EASYPOST_API_KEY) throw new HttpError(409, "Add your EasyPost API key in Settings → Connections → EasyPost");
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Basic ${btoa(`${env.EASYPOST_API_KEY}:`)}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message ?? `${res.status}`;
    const detail = (json?.error?.errors ?? []).map((e: any) => e.message ?? e).filter(Boolean).join("; ");
    throw new HttpError(res.status === 401 ? 502 : 422, `EasyPost: ${msg}${detail ? ` — ${detail}` : ""}`);
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
  phone: normalizePhone(a.phone, a.country) || undefined,
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

/**
 * Every carrier's rates from an EasyPost shipment or order, cheapest first, with each box's own
 * price for the same service on a split order. The cheapest account wins when a carrier has two.
 */
function toRates(raw: any[], shipments?: any[]): Rate[] {
  const boxPrice = (r: any) => {
    if (!shipments || shipments.length < 2) return undefined;
    const each = shipments.map((s) => Math.min(...(s.rates ?? []).filter((x: any) => x.carrier === r.carrier && x.service === r.service).map((x: any) => Number(x.rate)), Infinity));
    return splitCost(Number(r.rate), each.map((n) => (Number.isFinite(n) ? n : NaN)));
  };
  const best = new Map<string, any>();
  for (const r of raw ?? []) {
    if (!r?.carrier || !r?.service || !Number.isFinite(Number(r.rate))) continue;
    if (r.carrier === "USPS" && !USPS_SERVICES[r.service]) continue; // USPS extras (e.g. retail-only) aren't offered
    const code = codeFor(r.carrier, r.service);
    if (!best.has(code) || Number(r.rate) < Number(best.get(code).rate)) best.set(code, r);
  }
  return [...best.entries()]
    .map(([code, r]) => {
      const carrier = carrierName(r.carrier);
      const name = easypostServiceName(r.carrier, r.service);
      return {
        carrier,
        serviceCode: code,
        // UPS also comes direct; mark the EasyPost one so the two can be told apart
        serviceName: carrier === "UPS" ? `${name} · EasyPost` : name,
        total: Number(r.rate),
        listTotal: Number(r.retail_rate ?? r.list_rate ?? r.rate),
        currency: r.currency ?? "USD",
        days: r.delivery_days ?? r.est_delivery_days ?? null,
        ...(boxPrice(r) ? { perBox: boxPrice(r) } : {}),
      };
    })
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
  return { kind: "order" as const, id: o.id as string, rates: o.rates as any[], shipments: o.shipments as any[] };
}

export async function getEasypostRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs): Promise<Rate[]> {
  if (!domestic(to) && !customs) return []; // can't quote abroad without a customs list
  const c = await create(env, from, to, parcels, signature, "GIF", undefined, customs);
  return toRates(c.rates, c.kind === "order" ? c.shipments : undefined);
}

async function download(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(502, `Couldn't download the label from EasyPost (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Buys a label (or one per box) from any EasyPost carrier. shipmentId is stored as "ep:<id>,<id>" for refunds. */
export async function buyEasypost(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; signature?: Signature; customs?: Customs },
): Promise<ShipResult & { format: "PNG" | "ZPL"; carrier: string }> {
  const { raw, service } = parseEasypostCode(serviceCode);
  const label = easypostServiceName(raw, service);
  const c = await create(env, from, to, parcels, opts.signature, opts.labelFormat, opts.reference, opts.customs);
  const shipments: any[] = [];
  if (c.kind === "shipment") {
    const rate = c.rates.filter((r) => r.carrier === raw && r.service === service).sort((a, b) => Number(a.rate) - Number(b.rate))[0];
    if (!rate) throw new HttpError(422, `${label} isn't available for this package`);
    shipments.push(await ep(env, "POST", `/shipments/${c.id}/buy`, { rate: { id: rate.id } }));
  } else {
    const o = await ep(env, "POST", `/orders/${c.id}/buy`, { carrier: raw, service });
    shipments.push(...(o.shipments ?? []));
  }
  const zpl = opts.labelFormat === "ZPL";
  const labels: string[] = [];
  for (const s of shipments) {
    const url = zpl ? s.postage_label?.label_zpl_url ?? s.postage_label?.label_url : s.postage_label?.label_url;
    if (url) labels.push(await download(url));
  }
  // Customs paperwork (commercial invoice / CN23) when the carrier doesn't print it on the label itself
  const forms: { type: string; data: string }[] = [];
  for (const s of shipments) {
    for (const f of s.forms ?? []) {
      if (f?.form_url) forms.push({ type: String(f.form_type ?? "Customs form").replace(/_/g, " "), data: await download(f.form_url) });
    }
  }
  return {
    carrier: carrierName(raw),
    forms,
    shipmentId: `ep:${shipments.map((s) => s.id).join(",")}`,
    trackingNumbers: shipments.map((s) => s.tracking_code).filter(Boolean),
    labels,
    cost: Math.round(shipments.reduce((n, s) => n + Number(s.selected_rate?.rate ?? 0), 0) * 100) / 100,
    currency: shipments[0]?.selected_rate?.currency ?? "USD",
    format: zpl ? "ZPL" : "PNG",
    ...(shipments.length > 1 ? { perBox: shipments.map((s) => Math.round(Number(s.selected_rate?.rate ?? 0) * 100) / 100) } : {}),
  };
}

/** Asks for a refund of every label in the shipment (USPS refunds take a couple of weeks). */
export async function refundEasypost(env: Env, shipmentId: string) {
  for (const id of shipmentId.replace(/^ep:/, "").split(",").filter(Boolean)) {
    await ep(env, "POST", `/shipments/${id}/refund`);
  }
}

export async function testEasypost(env: Env) {
  await ep(env, "GET", "/shipments?page_size=1");
}

export const uspsTrackingUrl = (n: string) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`;

/** Kept for older callers and tests. */
export const getUspsRates = getEasypostRates;
export const buyUsps = buyEasypost;
export const refundUsps = refundEasypost;

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
