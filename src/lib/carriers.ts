// One place that quotes, buys and voids across carriers (UPS direct; USPS, FedEx and the rest via EasyPost).
import type { Env } from "../env";
import { createShipment, getRates as getUpsRates, trackingUrl as upsTrackingUrl, upsConfigured, voidShipment, type Address, type Parcel, type Rate, type Signature } from "./ups";
import { buyEasypost, carrierName, easypostConfigured, getEasypostRates, isEasypostCode, parseEasypostCode, refundEasypost, uspsTrackingUrl } from "./easypost";
import { HttpError } from "./util";
import type { Customs } from "./customs";

export const anyCarrier = (env: Env) => upsConfigured(env) || easypostConfigured(env);

/** Every service from every connected carrier, cheapest first. One carrier failing doesn't hide the other. */
export async function getAllRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs): Promise<Rate[]> {
  const jobs: Promise<Rate[]>[] = [];
  if (upsConfigured(env)) jobs.push(getUpsRates(env, from, to, parcels, signature, customs).then((r) => r.map((x) => ({ ...x, carrier: "UPS" }))));
  if (easypostConfigured(env)) jobs.push(getEasypostRates(env, from, to, parcels, signature, customs));
  if (!jobs.length) throw new HttpError(409, "Connect UPS or EasyPost in Settings → Connections to get rates");
  const settled = await Promise.allSettled(jobs);
  const rates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const errors = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => s.reason);
  if (!rates.length && errors.length) throw errors[0];
  return rates.sort((a, b) => a.total - b.total);
}

export const carrierOf = (serviceCode: string) => (isEasypostCode(serviceCode) ? carrierName(parseEasypostCode(serviceCode).raw) : "UPS");

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
  if (isEasypostCode(serviceCode)) {
    const r = await buyEasypost(env, from, to, parcels, serviceCode, opts);
    return { ...r, forms: r.forms ?? [] };
  }
  const r = await createShipment(env, from, to, parcels, serviceCode, opts);
  return { carrier: "UPS", ...r, forms: r.forms ?? [], format: opts.labelFormat as "GIF" | "ZPL" | "PNG" };
}

export async function voidLabel(env: Env, shipmentId: string) {
  if (shipmentId.startsWith("ep:")) return refundEasypost(env, shipmentId);
  return voidShipment(env, shipmentId);
}
