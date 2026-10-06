import type { Env } from "../env";
import { HttpError, cachedToken, setSetting } from "./util";
import type { Customs } from "./customs";

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
  carrier?: string; // "UPS" | "USPS"
  serviceCode: string;
  serviceName: string;
  total: number;
  listTotal: number;
  currency: string;
  days: number | null;
  perBox?: number[]; // multi-box shipments: what each box costs (adds up to total)
  alt?: string[]; // the same service's codes from other connections it stands in for (see dedupeRates)
}

/** Shares a total across boxes in proportion to each box's own charge (so per-box costs add up). */
export function splitCost(total: number, parts: number[]): number[] | undefined {
  if (parts.length < 2 || parts.some((x) => !Number.isFinite(x) || x < 0)) return undefined;
  const sum = parts.reduce((n, x) => n + x, 0);
  const shares = sum > 0 ? parts.map((x) => (x / sum) * total) : parts.map(() => total / parts.length);
  const cents = shares.map((x) => Math.round(x * 100) / 100);
  cents[cents.length - 1] = Math.round((total - cents.slice(0, -1).reduce((n, x) => n + x, 0)) * 100) / 100; // rounding goes on the last box
  return cents;
}

export function upsConfigured(env: Env) {
  return !!(env.UPS_CLIENT_ID && env.UPS_CLIENT_SECRET && env.UPS_ACCOUNT_NUMBER);
}

function base(env: Env) {
  return env.UPS_ENV === "production" ? "https://onlinetools.ups.com" : "https://wwwcie.ups.com";
}

// Keyed by mode and Client ID, so new keys never reuse a token issued for the old ones
const tokenKey = (env: Env) => `ups_access_${env.UPS_ENV}_${(env.UPS_CLIENT_ID ?? "").slice(-8)}`;

async function token(env: Env): Promise<string> {
  if (!upsConfigured(env)) throw new HttpError(409, "UPS is not connected");
  return cachedToken(env, tokenKey(env), async () => {
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

/** Shown when UPS accepts the keys but refuses the request itself. */
const authHelp = (env: Env) =>
  `UPS accepted your keys but refused this request (Invalid Authentication Information). In developer.ups.com → Apps → your app: ` +
  `1) under Products, make sure Rating and Shipping are added (and Address Validation if you use it); ` +
  `2) make sure UPS account ${env.UPS_ACCOUNT_NUMBER} is the billing account linked to the app, and that the Account number in Settings → Connections matches it exactly (6 characters, no spaces).`;

async function ups<T = any>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const send = async () =>
    fetch(base(env) + path, {
      method,
      headers: {
        authorization: `Bearer ${await token(env)}`,
        "content-type": "application/json",
        transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
        transactionSrc: "helpdesk",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await send();
  if (res.status === 401) {
    // The saved token may be from older keys or revoked: get a fresh one and try once more
    await setSetting(env, tokenKey(env), null);
    res = await send();
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) {
    const errs = json?.response?.errors as { code: string; message: string }[] | undefined;
    if (res.status === 401 || errs?.some((e) => e.code === "250002")) throw new HttpError(502, authHelp(env));
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

/**
 * Carriers want plain digits. US/Canada numbers become the 10-digit form (a leading +1 or 1 is
 * dropped, extensions are cut off); others keep their country code without the + or 00.
 */
export function normalizePhone(phone: string | null | undefined, country = "US"): string {
  if (!phone) return "";
  const main = phone.split(/\s*(?:ext\.?|x|#)\s*\d*$/i)[0];
  let d = main.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (["US", "CA", "PR"].includes((country || "US").toUpperCase()) && d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.slice(0, 15);
}

function party(a: Address, residential = false) {
  return {
    Name: trunc(a.company || a.name, 35),
    AttentionName: trunc(a.name, 35),
    ...(normalizePhone(a.phone, a.country) ? { Phone: { Number: normalizePhone(a.phone, a.country) } } : {}),
    Address: upsAddress(a, { residential }),
  };
}

function pkg(p: Parcel, packagingKey: "PackagingType" | "Packaging", signature?: Signature, reference?: string) {
  return {
    [packagingKey]: { Code: "02" }, // customer-supplied box
    // Order number on the label. Package level: UPS refuses shipment-level references on many shipments
    ...(reference ? { ReferenceNumber: { Value: trunc(reference, 35) } } : {}),
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

export const isInternationalAddress = (to: Address) => (to.country || "US").toUpperCase() !== "US";
const customsValue = (c?: Customs) => (c ? c.items.reduce((n, i) => n + i.qty * i.unitValue, 0) : 0);
/** UPS wants the invoice total for US → Canada / Puerto Rico shipments, also when rating. */
const invoiceLineTotal = (to: Address, c?: Customs) =>
  c && ["CA", "PR"].includes((to.country || "").toUpperCase())
    ? { InvoiceLineTotal: { CurrencyCode: "USD", MonetaryValue: String(Math.max(1, Math.ceil(customsValue(c)))) } }
    : {};

function internationalForms(to: Address, c: Customs) {
  const reason = { gift: "GIFT", sample: "SAMPLE", returned_goods: "RETURN" }[c.contents as string] ?? "SALE";
  const d = new Date();
  return {
    InternationalForms: {
      FormType: "01", // commercial invoice (UPS Paperless Invoice when enabled on the account)
      InvoiceDate: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      ReasonForExport: reason,
      CurrencyCode: "USD",
      Contacts: { SoldTo: party(to, to.residential ?? true) },
      Product: c.items.filter((i) => i.qty > 0).map((i) => ({
        Description: [trunc(i.description, 35)],
        ...(i.hsCode ? { CommodityCode: i.hsCode } : {}),
        OriginCountryCode: i.origin || "US",
        Unit: { Number: String(i.qty), Value: i.unitValue.toFixed(2), UnitOfMeasurement: { Code: "PCS", Description: "Pieces" } },
        ...(i.unitWeightLb > 0 ? { ProductWeight: { UnitOfMeasurement: { Code: "LBS" }, Weight: String(Math.max(0.1, Math.round(i.unitWeightLb * i.qty * 10) / 10)) } } : {}),
      })),
    },
  };
}

export function buildRateRequest(account: string, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs) {
  if (isInternationalAddress(to)) signature = undefined; // delivery confirmation is US-only
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
        ...invoiceLineTotal(to, customs),
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
      const total = negotiated !== undefined ? Number(negotiated) : list;
      const pkgs = asArray<any>(r.RatedPackage);
      const perBox = splitCost(total, pkgs.map((p) => Number(p.NegotiatedCharges?.TotalCharge?.MonetaryValue ?? p.TotalCharges?.MonetaryValue ?? NaN)));
      return {
        serviceCode: code,
        serviceName: UPS_SERVICES[code] ?? `UPS service ${code}`,
        total: negotiated !== undefined ? Number(negotiated) : list,
        listTotal: list,
        currency: r.TotalCharges?.CurrencyCode ?? "USD",
        days: days ? Number(days) : null,
        ...(perBox ? { perBox } : {}),
      };
    })
    .sort((a: Rate, b: Rate) => a.total - b.total);
}

export async function getRates(env: Env, from: Address, to: Address, parcels: Parcel[], signature?: Signature, customs?: Customs): Promise<Rate[]> {
  const json = await ups(env, "POST", `/api/rating/${API_VERSION}/Shop`, buildRateRequest(env.UPS_ACCOUNT_NUMBER!, from, to, parcels, signature, customs));
  return parseRates(json);
}

export function buildShipRequest(
  account: string,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; description?: string; signature?: Signature; customs?: Customs },
) {
  const intl = isInternationalAddress(to);
  if (intl && !opts.customs) throw new HttpError(422, "International shipments need customs details");
  if (intl && !normalizePhone(to.phone, to.country)) throw new HttpError(422, "UPS needs the recipient's phone number for international shipments");
  const signature = intl ? undefined : opts.signature;
  const charges: any[] = [{ Type: "01", BillShipper: { AccountNumber: account } }];
  if (intl && opts.customs?.dutiesPaidBy === "sender") charges.push({ Type: "02", BillShipper: { AccountNumber: account } });
  return {
    ShipmentRequest: {
      Request: { RequestOption: "nonvalidate" },
      Shipment: {
        Description: trunc(opts.description || "Merchandise", 50),
        Shipper: { ...party(from), ShipperNumber: account },
        ShipFrom: party(from),
        ShipTo: party(to, to.residential ?? true),
        PaymentInformation: { ShipmentCharge: charges },
        Service: { Code: serviceCode },
        ...(intl ? { ...invoiceLineTotal(to, opts.customs), ShipmentServiceOptions: internationalForms(to, opts.customs!) } : {}),
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
        Package: parcels.map((p, i) => pkg(p, "Packaging", signature, opts.reference ? (parcels.length > 1 ? `${opts.reference} box ${i + 1}/${parcels.length}` : opts.reference) : undefined)),
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
  forms?: { type: string; data: string }[]; // customs paperwork, base64 PDF
  perBox?: number[]; // what each box cost, when the carrier says
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
    forms: asArray<any>(r.Form).map((f) => f?.Image?.GraphicImage).filter(Boolean).map((data: string) => ({ type: "Commercial invoice", data })),
  };
}

export async function createShipment(
  env: Env,
  from: Address,
  to: Address,
  parcels: Parcel[],
  serviceCode: string,
  opts: { reference?: string; labelFormat: "GIF" | "ZPL"; description?: string; signature?: Signature; customs?: Customs },
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
/** Signs in, then asks for one real rate, so a missing product or unlinked account shows up here too. */
export async function testUps(env: Env) {
  await token(env);
  const from: Address = { name: "Test", address1: "100 Main St", city: "New York", state: "NY", zip: "10001", country: "US", phone: "2125550100" };
  const to: Address = { name: "Test", address1: "200 Main St", city: "Los Angeles", state: "CA", zip: "90001", country: "US", residential: true };
  const req = buildRateRequest(env.UPS_ACCOUNT_NUMBER!, from, to, [{ length: 10, width: 8, height: 4, weight: 1 }]);
  await ups(env, "POST", `/api/rating/${API_VERSION}/Shop`, req);
}

export async function voidShipment(env: Env, shipmentId: string) {
  await ups(env, "DELETE", `/api/shipments/${API_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`);
}

export const trackingUrl = (n: string) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`;

export interface AddressCheck {
  status: "valid" | "corrected" | "ambiguous" | "invalid" | "unchecked";
  residential: boolean | null;
  suggestion: Address | null;
  candidates?: Address[];
  provider: "UPS" | "EasyPost" | null;
  message: string;
}

const norm = (s: string | undefined) => (s ?? "").toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
const zip5 = (z: string | undefined) => (z ?? "").replace(/\D/g, "").slice(0, 5);

/** True when a candidate only differs by formatting, abbreviations or a ZIP+4. */
export function sameAddress(a: Address, b: Address): boolean {
  const abbr = (s: string) =>
    norm(s)
      .replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE").replace(/\bROAD\b/g, "RD").replace(/\bDRIVE\b/g, "DR")
      .replace(/\bBOULEVARD\b/g, "BLVD").replace(/\bLANE\b/g, "LN").replace(/\bCOURT\b/g, "CT").replace(/\bPLACE\b/g, "PL")
      .replace(/\bAPARTMENT\b/g, "APT").replace(/\bSUITE\b/g, "STE").replace(/\bNORTH\b/g, "N").replace(/\bSOUTH\b/g, "S")
      .replace(/\bEAST\b/g, "E").replace(/\bWEST\b/g, "W");
  const lines = (x: Address) => abbr([x.address1, x.address2].filter(Boolean).join(" "));
  return lines(a) === lines(b) && norm(a.city) === norm(b.city) && norm(a.state) === norm(b.state) && zip5(a.zip) === zip5(b.zip);
}

/**
 * UPS Address Validation – Street Level (US and Puerto Rico), with residential/commercial classification.
 * Needs the "Address Validation" product added to the UPS developer app.
 */
export async function validateAddressUps(env: Env, a: Address): Promise<AddressCheck> {
  const json = await ups(env, "POST", "/api/addressvalidation/v2/3", {
    XAVRequest: {
      AddressKeyFormat: {
        ConsigneeName: trunc(a.company || a.name, 35),
        AddressLine: [a.address1, a.address2].filter(Boolean).map((l) => trunc(l, 35)),
        PoliticalDivision2: a.city,
        PoliticalDivision1: a.state,
        PostcodePrimaryLow: zip5(a.zip),
        CountryCode: a.country || "US",
      },
    },
  });
  const r = json?.XAVResponse ?? {};
  const toAddr = (c: any): Address => {
    const k = c?.AddressKeyFormat ?? {};
    const al = asArray<string>(k.AddressLine);
    return {
      ...a,
      address1: al[0] ?? a.address1,
      address2: al[1] ?? a.address2,
      city: k.PoliticalDivision2 ?? a.city,
      state: k.PoliticalDivision1 ?? a.state,
      zip: k.PostcodeExtendedLow ? `${k.PostcodePrimaryLow}-${k.PostcodeExtendedLow}` : k.PostcodePrimaryLow ?? a.zip,
      country: k.CountryCode ?? a.country,
    };
  };
  const candidates = asArray<any>(r.Candidate);
  const cls = (c: any) => c?.AddressClassification?.Code ?? r.AddressClassification?.Code;
  const residential = (code: string | undefined) => (code === "2" ? true : code === "1" ? false : null);
  if (r.NoCandidatesIndicator !== undefined || !candidates.length) {
    return { status: "invalid", residential: null, suggestion: null, provider: "UPS", message: "UPS couldn't find this address" };
  }
  const first = toAddr(candidates[0]);
  if (r.ValidAddressIndicator !== undefined) {
    const same = sameAddress(a, first);
    return {
      status: same ? "valid" : "corrected",
      residential: residential(cls(candidates[0])),
      suggestion: same ? null : first,
      provider: "UPS",
      message: same ? "Verified by UPS" : "UPS suggests a corrected address",
    };
  }
  return {
    status: "ambiguous",
    residential: residential(cls(candidates[0])),
    suggestion: first,
    candidates: candidates.slice(0, 5).map(toAddr),
    provider: "UPS",
    message: "UPS found more than one possible match",
  };
}
