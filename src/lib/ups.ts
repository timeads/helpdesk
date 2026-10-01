import type { Env } from "../env";
import { HttpError, cachedToken } from "./util";

const API_VERSION = "v2409";

export const UPS_SERVICES: Record<string, string> = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "12": "UPS 3 Day Select",
  "13": "UPS Next Day Air Saver",
  "14": "UPS Next Day Air Early",
  "59": "UPS 2nd Day Air A.M.",
  "07": "UPS Worldwide Express",
  "08": "UPS Worldwide Expedited",
  "11": "UPS Standard",
  "54": "UPS Worldwide Express Plus",
  "65": "UPS Worldwide Saver",
  "75": "UPS Heavy Goods",
  "93": "UPS Ground Saver",
};

export interface Address {
  name: string;
  company?: string;
  phone?: string;
  email?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string; // 2-letter
  zip: string;
  country: string; // 2-letter
  residential?: boolean;
}

export interface Parcel {
  length: number;
  width: number;
  height: number;
  weight: number; // lb
  /** What's packed in this box (multi-box shipments); stored with the label, never sent to UPS. */
  contents?: { id: string; title: string; qty: number }[];
  box?: string;
  presetId?: number | null;
}

export type Signature = "standard" | "adult" | null | undefined;

export interface Rate {
  serviceCode: string;
  serviceName: string;
  total: number;
  listTotal: number;
  currency: string;
  days: number | null;
}

export function upsConfigured(env: Env) {
  return !!(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET && env.UPS_ACCOUNT_NUMBER);
}

function base(env: Env) {
  return env.UPS_ENV === "production" ? "https://onlinetools.ups.com" : "https://wwwcie.ups.com";
}

async function token(env: Env): Promise<string> {
  if (!upsConfigured(env)) throw new HttpError(409, "UPS is not connected");
  return cachedToken(env, `ups_access_${env.UPS_ENV}`, async () => {
    const res = await fetch(`${base(env)}/security/v1/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + btoa(`${env.UPS_CLIENT_ID}:${env.UPS_CLIENT_SECRET}`),
        "x-merchant-id": env.UPS_ACCOUNT_NUMBER!,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new HttpError(502, `UPS auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token: string; expires_in: string | number };
    return { token: j.access_token, expiresIn: Number(j.expires_in) || 3600 };
  });
}

async function ups<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base(env) + path, {
    method,
    headers: {
      authorization: `Bearer ${await token(env)}`,
      "content-type": "application/json",
      transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
      transactionSrc: "helpdesk",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) {
    const errs = json?.response?.errors as { code: string; message: string }[] | undefined;
    throw new HttpError(422, "UPS: " + (errs?.map((e) => e.message).join("; ") || text.slice(0, 300)));
  }
  return json as T;
}

const trunc = (s: string | undefined, n: number) => (s ?? "").slice(0, n);
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function upsAddress(a: Address, opts: { residential?: boolean } = {}) {
  return {
    AddressLine: [a.address1, a.address2].filter(Boolean).map((l) => trunc(l, 35)),
    City: trunc(a.city, 30),
    StateProvinceCode: a.state,
    PostalCode: a.zip,
    CountryCode: a.country,
    ...(opts.residential ? { ResidentialAddressIndicator: "" } : {}),
  };
}

function party(a: Address, residential = false) {
  return {
    Name: trunc(a.company || a.name, 35),
    AttentionName: trunc(a.name, 35),
    ...(a.phone ? { Phone: { Number: a.phone.replace(/[^\d]/g, "").slice(0, 15) } } : {}),
    Address: upsAddress(a, { residential }),
  };
}

function pkg(p: Parcel, packagingKey: "PackagingType" | "Packaging", signature?: Signature) {
  return {
    [packagingKey]: { Code: "02" }, // customer-supplied box
    Dimensions: {
      UnitOfMeasurement: { Code: "IN" },
      // Envelopes can be 0" deep; UPS needs whole inches ≥ 1
      Length: String(Math.max(1, Math.ceil(p.length))),
      Width: String(Math.max(1, Math.ceil(p.width))),
      Height: String(Math.max(1, Math.ceil(p.height))),
    },
    // Delivery confirmation: 2 = signature required, 3 = adult signature (US domestic, package level)
    ...(signature ? { PackageServiceOptions: { DeliveryConfirmation: { DCISType: signature === "adult" ? "3" : "2" } } } : {}),
    PackageWeight: {
      UnitOfMeasurement: { Code: "LBS" },
      Weight: String(Math.max(0.1, Math.round(p.weight * 10) / 10)),
    },
  };
}

export function buildRateRequest(account: string, from: Address, to: Address, parcels: Parcel[], signature?: Signature) {
  return {
    RateRequest: {
      Request: { RequestOption: "Shop" },
      Shipment: {
        Shipper: { ...party(from), ShipperNumber: account },
        ShipFrom: party(from),
        ShipTo: party(to, to.residential ?? true),
        PaymentDetails: { ShipmentCharge: [{ Type: "01", BillShipper: { AccountNumber: account } }] },
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
        NumOfPieces: String(parcels.length),
        Package: parcels.map((p) => pkg(p, "PackagingType", signature)),
      },
    },
  };
}

export function parseRates(json: any): Rate[] {
  const rated = asArray(json?.RateResponse?.RatedShipment);
  return rated
    .map((r: any) => {
      const code = r.Service?.Code as string;
      const list = Number(r.TotalCharges?.MonetaryValue ?? 0);
      const negotiated = r.NegotiatedRateCharges?.TotalCharge?.MonetaryValue;
      const days = r.GuaranteedDelivery?.BusinessDaysInTransit;
      return {
        serviceCode: code,
        serviceName: UPS_SERVICES[code] ?? `UPS service ${code}`,
        total: negotiated !== undefined ? Number(negotiated) : list,
        listTotal: list,
        currency: r.TotalCharges?.CurrencyCode ?? "USD",
        days: days ? Number(days) : null,
      };
    })
    .sort((a: Rate, b: Rate) => a.total - b.total);
}

export async function getRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature): Promise<Rate[]> {
  const json = await ups(env, "POST", `/api/rating/${API_VERSION}/Shop`, buildRateRequest(env.UPS_ACCOUNT_NUMBER!, from, to, parcels, signature));
  return parseRates(json);
}

export function buildShipRequest(
  account: string,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; description?: string; signature?: Signature },
) {
  return {
    ShipmentRequest: {
      Request: { RequestOption: "nonvalidate" },
      Shipment: {
        Description: trunc(opts.description || "Merchandise", 50),
        Shipper: { ...party(from), ShipperNumber: account },
        ShipFrom: party(from),
        ShipTo: party(to, to.residential ?? true),
        PaymentInformation: { ShipmentCharge: [{ Type: "01", BillShipper: { AccountNumber: account } }] },
        Service: { Code: serviceCode },
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
        ...(opts.reference ? { ReferenceNumber: { Value: trunc(opts.reference, 35) } } : {}),
        Package: parcels.map((p) => pkg(p, "Packaging", opts.signature)),
      },
      LabelSpecification: {
        LabelImageFormat: { Code: opts.labelFormat },
        HTTPUserAgent: "Mozilla/4.5",
        ...(opts.labelFormat === "ZPL" ? { LabelStockSize: { Height: "6", Width: "4" } } : {}),
      },
    },
  };
}

export interface ShipResult {
  shipmentId: string;
  trackingNumbers: string[];
  labels: string[]; // base64
  cost: number;
  currency: string;
}

export function parseShipResponse(json: any): ShipResult {
  const r = json?.ShipmentResponse?.ShipmentResults;
  if (!r) throw new HttpError(502, "UPS returned no shipment");
  const pkgs = asArray<any>(r.PackageResults);
  const negotiated = r.NegotiatedRateCharges?.TotalCharge;
  const total = negotiated ?? r.ShipmentCharges?.TotalCharges;
  return {
    shipmentId: r.ShipmentIdentificationNumber,
    trackingNumbers: pkgs.map((p) => p.TrackingNumber),
    labels: pkgs.map((p) => p.ShippingLabel?.GraphicImage).filter(Boolean),
    cost: Number(total?.MonetaryValue ?? 0),
    currency: total?.CurrencyCode ?? "USD",
  };
}

export async function createShipment(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; description?: string; signature?: Signature },
): Promise<ShipResult> {
  const json = await ups(
    env,
    "POST",
    `/api/shipments/${API_VERSION}/ship`,
    buildShipRequest(env.UPS_ACCOUNT_NUMBER!, from, to, parcels, serviceCode, opts),
  );
  return parseShipResponse(json);
}

/** Fetches an OAuth token to prove the keys and account number are valid. */
export async function testUps(env: Env) {
  await token(env);
}

export async function voidShipment(env: Env, shipmentId: string) {
  await ups(env, "DELETE", `/api/shipments/${API_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`);
}

export const trackingUrl = (n: string) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`;
