// One place that quotes, buys and voids across carriers (UPS direct; USPS, FedEx and the rest via EasyPost or Redo).
import type { Env } from "../env";
import { createShipment, getRates as getUpsRates, trackingUrl as upsTrackingUrl, upsConfigured, voidShipment, type Address, type Parcel, type Rate, type Signature } from "./ups";
import { buyEasypost, carrierName, easypostConfigured, getEasypostRates, isEasypostCode, parseEasypostCode, refundEasypost, uspsTrackingUrl } from "./easypost";
import { buyRedo, getRedoRates, isRedoCode, parseRedoCode, redoConfigured, voidRedo } from "./redo";
import { HttpError } from "./util";
import type { Customs } from "./customs";

export const anyCarrier = (env: Env) => upsConfigured(env) || easypostConfigured(env) || redoConfigured(env);

/** Every service from every connected carrier, cheapest first. One carrier failing doesn't hide the other. */
export async function getAllRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs): Promise<Rate[]> {
  const jobs: Promise<Rate[]>[] = [];
  if (upsConfigured(env)) jobs.push(getUpsRates(env, from, to, parcels, signature, customs).then((r) => r.map((x) => ({ ...x, carrier: "UPS" }))));
  if (easypostConfigured(env)) jobs.push(getEasypostRates(env, from, to, parcels, signature, customs));
  // Redo labels can't require a signature yet: leave Redo out when the order needs one
  if (redoConfigured(env) && !signature) jobs.push(getRedoRates(env, from, to, parcels, signature, customs));
  if (!jobs.length && redoConfigured(env)) throw new HttpError(409, "Redo labels can't require a signature yet — set Delivery signature to “No signature” to see Redo rates");
  if (!jobs.length) throw new HttpError(409, "Connect UPS, EasyPost or Redo in Settings → Connections to get rates");
  const settled = await Promise.allSettled(jobs);
  const rates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const errors = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => s.reason);
  if (!rates.length && errors.length) throw errors[0];
  return dedupeRates(rates);
}

/** "UPS 3 Day Select · Redo" and "UPS 3day Select" are the same service: carrier + name without spaces or the "· via" part. */
export const serviceKey = (r: Pick<Rate, "carrier" | "serviceName">) =>
  `${(r.carrier ?? "").toLowerCase()}|${r.serviceName.replace(/\s·\s.*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;

const via = (r: Rate) => (r.serviceCode.startsWith("redo:") ? 2 : r.serviceCode.startsWith("ep:") || r.serviceCode.startsWith("usps:") ? 1 : 0);

/**
 * One row per carrier service: the same service can come from several places (UPS direct, UPS through
 * EasyPost or Redo, or two carrier accounts in Redo). Keep the cheapest; on a tie, the direct connection.
 */
export function dedupeRates(rates: Rate[]): Rate[] {
  const best = new Map<string, Rate>();
  const codes = new Map<string, Set<string>>();
  for (const r of rates) {
    const k = serviceKey(r);
    codes.set(k, (codes.get(k) ?? new Set()).add(r.serviceCode));
    const cur = best.get(k);
    if (!cur || r.total < cur.total - 0.005 || (Math.abs(r.total - cur.total) <= 0.005 && via(r) < via(cur))) best.set(k, r);
  }
  // A rule or saved choice naming a hidden duplicate's code still finds the kept row
  return [...best.entries()].map(([k, r]) => {
    const alt = [...codes.get(k)!].filter((c) => c !== r.serviceCode);
    return alt.length ? { ...r, alt } : r;
  }).sort((a, b) => a.total - b.total);
}

export const carrierOf = (serviceCode: string) => (isRedoCode(serviceCode) ? carrierName(parseRedoCode(serviceCode).carrier) : isEasypostCode(serviceCode) ? carrierName(parseEasypostCode(serviceCode).raw) : "UPS");

/** The carrier's public tracking page (also sent to Shopify for the customer's shipping email). */
export function trackingUrlFor(carrier: string, n: string): string {
  const q = encodeURIComponent(n);
  switch (carrier) {
    case "UPS": return upsTrackingUrl(n);
    case "USPS": return uspsTrackingUrl(n);
    case "FedEx": return `https://www.fedex.com/fedextrack/?trknbr=${q}`;
    case "OnTrac": return `https://www.ontrac.com/tracking/?number=${q}`;
    case "DHL eCommerce": return `https://webtrack.dhlecs.com/?trackingnumber=${q}`;
    case "DHL Express": return `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${q}`;
    case "Amazon Shipping": return `https://track.amazon.com/tracking/${q}`;
    case "Canada Post": return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${q}`;
    default: return /^1Z/i.test(n) ? upsTrackingUrl(n) : `https://parcelsapp.com/en/tracking/${q}`;
  }
}

export async function purchase(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; signature?: Signature; customs?: Customs },
) {
  if (isRedoCode(serviceCode)) return buyRedo(env, from, to, parcels, serviceCode, opts);
  if (isEasypostCode(serviceCode)) {
    const r = await buyEasypost(env, from, to, parcels, serviceCode, opts);
    return { ...r, forms: r.forms ?? [] };
  }
  const r = await createShipment(env, from, to, parcels, serviceCode, opts);
  return { carrier: "UPS", ...r, forms: r.forms ?? [], format: opts.labelFormat as "GIF" | "ZPL" | "PNG" | "PDF" };
}

export async function voidLabel(env: Env, shipmentId: string) {
  if (shipmentId.startsWith("redo:")) return voidRedo(env, shipmentId);
  if (shipmentId.startsWith("ep:")) return refundEasypost(env, shipmentId);
  return voidShipment(env, shipmentId);
}
