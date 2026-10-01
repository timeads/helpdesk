// One place that quotes, buys and voids across carriers (UPS direct, USPS via EasyPost).
import type { Env } from "../env";
import { createShipment, getRates as getUpsRates, trackingUrl as upsTrackingUrl, upsConfigured, voidShipment, type Address, type Parcel, type Rate, type Signature } from "./ups";
import { buyUsps, easypostConfigured, getUspsRates, isUspsCode, refundUsps, uspsTrackingUrl } from "./easypost";
import { HttpError } from "./util";

export const anyCarrier = (env: Env) => upsConfigured(env) || easypostConfigured(env);

/** Every service from every connected carrier, cheapest first. One carrier failing doesn't hide the other. */
export async function getAllRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature): Promise<Rate[]> {
  const jobs: Promise<Rate[]>[] = [];
  if (upsConfigured(env)) jobs.push(getUpsRates(env, from, to, parcels, signature).then((r) => r.map((x) => ({ ...x, carrier: "UPS" }))));
  if (easypostConfigured(env)) jobs.push(getUspsRates(env, from, to, parcels, signature));
  if (!jobs.length) throw new HttpError(409, "Connect UPS or USPS in Settings → Credentials to get rates");
  const settled = await Promise.allSettled(jobs);
  const rates = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  const errors = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => s.reason);
  if (!rates.length && errors.length) throw errors[0];
  return rates.sort((a, b) => a.total - b.total);
}

export const carrierOf = (serviceCode: string) => (isUspsCode(serviceCode) ? "USPS" : "UPS");
export const trackingUrlFor = (carrier: string, n: string) => (carrier === "USPS" ? uspsTrackingUrl(n) : upsTrackingUrl(n));

export async function purchase(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; signature?: Signature },
) {
  if (isUspsCode(serviceCode)) return { carrier: "USPS", ...(await buyUsps(env, from, to, parcels, serviceCode, opts)) };
  const r = await createShipment(env, from, to, parcels, serviceCode, opts);
  return { carrier: "UPS", ...r, format: opts.labelFormat as "GIF" | "ZPL" | "PNG" };
}

export async function voidLabel(env: Env, shipmentId: string) {
  if (shipmentId.startsWith("ep:")) return refundUsps(env, shipmentId);
  return voidShipment(env, shipmentId);
}
