// Redo shipping labels through Redo's GraphQL API: quote every carrier connected in Redo (including your own
// carrier accounts), buy, and void. Labels are paid from the Redo outbound-labels balance.
// One purchase is one carrier shipment: UPS and FedEx carry up to 5 boxes in one; any other carrier needs
// one shipment per box, so split orders are quoted box by box and the prices added up.
import type { Env } from "../env";
import { carrierName } from "./easypost";
import { normalizePhone, type Address, type Parcel, type Rate, type ShipResult } from "./ups";
import type { Customs, CustomsItem } from "./customs";
import { HttpError, randomId } from "./util";

export const redoConfigured = (env: Env) => !!(env.REDO_API_TOKEN && env.REDO_STORE_ID);
export const isRedoCode = (code: string) => code.startsWith("redo:");

// ---------------------------------------------------------------- GraphQL

// Address fields Redo's input type turned out not to have (learned from its validation errors, then left out)
const unknownFields = new Set<string>();

/** An enum value (written bare in GraphQL, not quoted). */
class Enum { constructor(public v: string) {} }
const E = (v: string) => new Enum(v);

/** A JS value as a GraphQL input literal: { key: value }, [a b], "string", ENUM. */
export function literal(v: unknown): string {
  if (v instanceof Enum) return v.v;
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(literal).join(" ")}]`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).filter(([k, x]) => x !== undefined && !unknownFields.has(k)).map(([k, x]) => `${k}: ${literal(x)}`).join(" ")}}`;
  return JSON.stringify(v);
}


async function gql<T>(env: Env, build: () => string): Promise<T> {
  if (!redoConfigured(env)) throw new HttpError(409, "Add your Redo API token and store ID in Settings → Connections → Redo");
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.getredo.com/v3/account/${encodeURIComponent(env.REDO_STORE_ID!.trim())}/graphql`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.REDO_API_TOKEN!.trim()}`, "content-type": "application/json" },
      body: JSON.stringify({ query: build() }),
    });
    const json: any = await res.json().catch(() => ({}));
    const errors: any[] = json?.errors ?? [];
    if (res.ok && !errors.length && json?.data) return json.data as T;
    // An optional address field Redo doesn't take: drop it and ask again
    const missing = errors.map((e) => /Field "(\w+)" is not defined by type/.exec(String(e?.message ?? ""))?.[1]).find((f) => f && ["phone", "company", "street2", "email"].includes(f));
    if (missing && !unknownFields.has(missing)) { unknownFields.add(missing); continue; }
    throw redoError(res.status, errors);
  }
  throw new HttpError(502, "Redo: the request kept being rejected");
}

function redoError(status: number, errors: any[]) {
  const e = errors[0] ?? {};
  const code = String(e?.extensions?.code ?? "");
  const msg = String(e?.message ?? `HTTP ${status}`);
  if (status === 401) return new HttpError(502, "Redo turned down the API token — check it in Settings → Connections → Redo");
  if (code === "INSUFFICIENT_SCOPE" || status === 403) return new HttpError(502, "The Redo token needs the Shipping read and Shipping write scopes (Redo → Settings → Developer)");
  if (code === "INSUFFICIENT_FUNDS") return new HttpError(402, "Your Redo outbound labels balance can't cover this label — add funds in the Redo dashboard");
  if (code === "RATE_NOT_FOUND") return new HttpError(409, "That Redo rate is no longer available — refresh the rates and try again");
  return new HttpError(status >= 500 ? 502 : 422, `Redo: ${msg}`);
}

// ---------------------------------------------------------------- Request shape

const address = (a: Address) => {
  const out: Record<string, unknown> = {
    name: a.name || undefined,
    company: a.company || undefined,
    street1: a.address1,
    street2: a.address2 || undefined,
    city: a.city,
    state: a.state || undefined,
    zip: a.zip,
    country: (a.country || "US").toUpperCase(),
    phone: normalizePhone(a.phone, a.country) || undefined,
  };
  return out;
};

const parcel = (p: Parcel) => ({
  weight: { unit: E("POUND"), value: Math.max(0.01, Math.round(p.weight * 100) / 100) },
  length: { unit: E("INCH"), value: Math.max(1, p.length) },
  width: { unit: E("INCH"), value: Math.max(1, p.width) },
  height: { unit: E("INCH"), value: Math.max(0.25, p.height || 0.25) },
});

const CONTENTS: Record<Customs["contents"], string> = {
  merchandise: "MERCHANDISE", gift: "GIFT", sample: "SAMPLE", returned_goods: "RETURNED_GOODS", documents: "DOCUMENTS", other: "MERCHANDISE",
};

/** The customs declaration for a set of boxes: the boxes' own items on a split order, else every item. */
function customsFor(c: Customs, boxes: Parcel[], split: boolean) {
  let items: CustomsItem[] = c.items;
  if (split) {
    const byLine = new Map(c.items.map((i) => [i.lineId, i]));
    const lines = boxes.flatMap((p) => p.contents ?? []);
    if (!lines.length) throw new HttpError(422, "Split orders going abroad need each box's items assigned (What goes in each box)");
    items = lines.map((x) => ({ ...(byLine.get(x.id) ?? c.items[0]), qty: x.qty })).filter((i) => i && i.qty > 0);
  }
  const noHs = items.find((i) => !i.hsCode?.replace(/\D/g, ""));
  if (noHs) throw new HttpError(422, `Redo needs an HS code for every customs item (missing for “${noHs.description}”) — add one in Settings → International`);
  return {
    contentsType: E(CONTENTS[c.contents] ?? "MERCHANDISE"),
    nonDeliveryOption: E(c.nonDelivery === "abandon" ? "TREAT_AS_ABANDONED" : "RETURN"),
    items: items.slice(0, 100).map((i) => ({
      description: i.description.slice(0, 100),
      quantity: Math.max(1, Math.round(i.qty)),
      unitValue: { amount: (Math.round(i.unitValue * 100) / 100).toFixed(2), currency: "USD" },
      unitWeight: { unit: E("POUND"), value: Math.max(0.01, Math.round(i.unitWeightLb * 100) / 100) },
      originCountry: (i.origin || "US").toUpperCase(),
      hsTariffNumber: i.hsCode.replace(/\D/g, ""),
    })),
  };
}

const domestic = (to: Address) => (to.country || "US").toUpperCase() === "US";

function shipmentRequest(from: Address, to: Address, boxes: Parcel[], customs: Customs | undefined, split: boolean) {
  const intl = !domestic(to);
  return {
    fromAddress: address(from),
    toAddress: address(to),
    parcels: boxes.map(parcel),
    ...(intl && customs ? { customs: customsFor(customs, boxes, split), deliveredDutyPaid: customs.dutiesPaidBy === "sender" } : {}),
  };
}

// ---------------------------------------------------------------- Rates

interface RedoRate { carrier: string; service: string; carrierAccountId: string; rate: { amount: string; currency: string }; deliveryDays?: number | null }

async function quote(env: Env, request: object): Promise<RedoRate[]> {
  const data = await gql<{ getShippingLabelQuotes: { rates: RedoRate[] | null } }>(env, () =>
    `mutation { getShippingLabelQuotes(input: ${literal(request)}) { rates { carrier service carrierAccountId rate { amount currency } deliveryDays } messages { carrier carrierAccountId message } } }`);
  return (data.getShippingLabelQuotes?.rates ?? []).filter((r) => r?.carrier && r?.service && Number.isFinite(Number(r.rate?.amount)));
}

// Service code: redo:<1 = one shipment | n = one per box>:<carrier account>:<carrier>:<service>
const codeFor = (mode: "1" | "n", r: Pick<RedoRate, "carrierAccountId" | "carrier" | "service">) =>
  `redo:${mode}:${[r.carrierAccountId, r.carrier, r.service].map(encodeURIComponent).join(":")}`;
export function parseRedoCode(code: string) {
  const [, mode, acct = "", carrier = "", service = ""] = code.split(":");
  return { mode: mode === "n" ? "n" as const : "1" as const, carrierAccountId: decodeURIComponent(acct), carrier: decodeURIComponent(carrier), service: decodeURIComponent(service) };
}

/** "GroundAdvantage" → "Ground Advantage", "UPS_GROUND" → "Ground". */
export function redoServiceName(carrier: string, service: string) {
  const c = carrierName(carrier);
  const s = service.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(new RegExp(`^${carrier}\\s+`, "i"), "").toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bUsps\b/g, "USPS").replace(/\bUps\b/g, "UPS").replace(/\bAm\b/g, "AM");
  return `${c} ${s} · Redo`;
}

const toRate = (mode: "1" | "n", r: RedoRate, total: number, perBox?: number[]): Rate => ({
  carrier: carrierName(r.carrier),
  serviceCode: codeFor(mode, r),
  serviceName: redoServiceName(r.carrier, r.service),
  total: Math.round(total * 100) / 100,
  listTotal: Math.round(total * 100) / 100,
  currency: r.rate.currency || "USD",
  days: r.deliveryDays ?? null,
  ...(perBox ? { perBox } : {}),
});

const key = (r: RedoRate) => `${r.carrierAccountId}|${r.carrier}|${r.service}`;

export async function getRedoRates(env: Env, from: Address, to: Address, parcels: Parcel[], _signature?: unknown, customs?: Customs): Promise<Rate[]> {
  if (!domestic(to) && !customs) return []; // abroad needs the customs list first
  if (parcels.length === 1) return (await quote(env, shipmentRequest(from, to, parcels, customs, false))).map((r) => toRate("1", r, Number(r.rate.amount)));
  // Several boxes: one shipment for carriers that carry them together (UPS, FedEx), else box by box added up
  const [together, ...each] = await Promise.all([
    parcels.length <= 5 ? quote(env, shipmentRequest(from, to, parcels, customs, true)).catch(() => [] as RedoRate[]) : Promise.resolve([] as RedoRate[]),
    ...parcels.map((p) => quote(env, shipmentRequest(from, to, [p], customs, true))),
  ]);
  const out = together.map((r) => toRate("1", r, Number(r.rate.amount)));
  const have = new Set(together.map(key));
  for (const r of each[0] ?? []) {
    if (have.has(key(r))) continue;
    const per = each.map((list) => list.find((x) => key(x) === key(r)));
    if (per.some((x) => !x)) continue; // not offered for every box
    const prices = per.map((x) => Math.round(Number(x!.rate.amount) * 100) / 100);
    out.push(toRate("n", r, prices.reduce((a, b) => a + b, 0), prices));
  }
  return out;
}

// ---------------------------------------------------------------- Buying & voiding

interface Purchased { shipmentId: string; carrier: string; service: string; rate: { amount: string; currency: string }; shipmentPackages: { trackingNumber: string | null; labelUrl: string | null }[] }

async function buyOne(env: Env, request: object, sel: ReturnType<typeof parseRedoCode>, idempotencyKey: string): Promise<Purchased> {
  const data = await gql<{ purchaseCarrierShipment: Purchased }>(env, () =>
    `mutation { purchaseCarrierShipment(input: ${literal({ request, carrier: sel.carrier, service: sel.service, carrierAccountId: sel.carrierAccountId, idempotencyKey })}) { shipmentId carrier service rate { amount currency } shipmentPackages { trackingNumber labelUrl } } }`);
  return data.purchaseCarrierShipment;
}

export type LabelFormat = "PNG" | "GIF" | "ZPL" | "PDF";

/** What kind of file a label is, from its first bytes (labels are kept as base64 whatever the kind). */
export function sniffLabel(bytes: Uint8Array): LabelFormat | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "PDF"; // %PDF
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "PNG";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "GIF";
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith("^XA") || head.startsWith("${")) return "ZPL";
  return null;
}

async function download(env: Env, url: string): Promise<{ data: string; format: LabelFormat }> {
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) res = await fetch(url, { headers: { authorization: `Bearer ${env.REDO_API_TOKEN}` } });
  if (!res.ok) throw new HttpError(502, `Couldn't download the label from Redo (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const format = sniffLabel(bytes);
  if (!format) throw new HttpError(502, "Redo's label isn't a PDF, PNG, GIF or ZPL file");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin), format };
}

/** Buys the label (or one per box). shipmentId is stored as "redo:<id>,<id>" for voiding. */
export async function buyRedo(
  env: Env, from: Address, to: Address, parcels: Parcel[], serviceCode: string,
  opts: { reference?: string; customs?: Customs },
): Promise<ShipResult & { format: LabelFormat; carrier: string }> {
  const sel = parseRedoCode(serviceCode);
  if (!domestic(to) && !opts.customs) throw new HttpError(422, "International shipments need customs details");
  if (sel.mode === "1" && parcels.length > 5) throw new HttpError(422, "Redo carries at most 5 boxes in one shipment");
  const base = `${(opts.reference || "label").replace(/[^\w#-]/g, "").slice(0, 60)}-${randomId(9)}`;
  const groups = sel.mode === "1" ? [parcels] : parcels.map((p) => [p]);
  const bought: Purchased[] = [];
  try {
    for (const [i, g] of groups.entries()) {
      bought.push(await buyOne(env, shipmentRequest(from, to, g, opts.customs, parcels.length > 1), sel, `${base}-${i + 1}`));
    }
  } catch (e) {
    // Don't leave some boxes paid for when the rest failed
    for (const b of bought) await voidRedo(env, `redo:${b.shipmentId}`).catch(() => {});
    throw e;
  }
  const pkgs = bought.flatMap((b) => b.shipmentPackages ?? []);
  const files = [];
  for (const p of pkgs) if (p.labelUrl) files.push(await download(env, p.labelUrl));
  const format = files[0]?.format ?? "PDF";
  const costs = bought.map((b) => Math.round(Number(b.rate?.amount ?? 0) * 100) / 100);
  return {
    carrier: carrierName(bought[0]?.carrier ?? sel.carrier),
    shipmentId: `redo:${bought.map((b) => b.shipmentId).join(",")}`,
    trackingNumbers: pkgs.map((p) => p.trackingNumber).filter((n): n is string => !!n),
    labels: files.filter((f) => f.format === format).map((f) => f.data),
    cost: Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100,
    currency: bought[0]?.rate?.currency ?? "USD",
    format,
    forms: [],
    ...(bought.length > 1 ? { perBox: costs } : {}),
  };
}

/** Cancels the label(s) and asks Redo for the refund to the labels balance. */
export async function voidRedo(env: Env, shipmentId: string) {
  const rejected: string[] = [];
  for (const id of shipmentId.replace(/^redo:/, "").split(",").filter(Boolean)) {
    const data = await gql<{ voidCarrierShipment: { shipmentId: string; refundStatus: string | null } }>(env, () =>
      `mutation { voidCarrierShipment(shipmentId: ${JSON.stringify(id)}) { shipmentId refundStatus } }`);
    if (data.voidCarrierShipment?.refundStatus === "REJECTED") rejected.push(id);
  }
  if (rejected.length) throw new HttpError(409, "The carrier refused to cancel this label (it may already have been scanned) — contact Redo support for a refund");
}

/** Settings → Connections test: a sample domestic quote. */
export async function testRedo(env: Env, from: Address) {
  const rates = await quote(env, shipmentRequest(from, { name: "Test", address1: "1600 Pennsylvania Ave NW", city: "Washington", state: "DC", zip: "20500", country: "US" }, [{ length: 10, width: 8, height: 4, weight: 2 }], undefined, false));
  const carriers = [...new Set(rates.map((r) => carrierName(r.carrier)))];
  return { rates: rates.length, carriers };
}

// ---------------------------------------------------------------- What Redo's shipping API accepts

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
const typeName = (t: TypeRef | null | undefined): string => (!t ? "?" : t.kind === "NON_NULL" ? `${typeName(t.ofType)}!` : t.kind === "LIST" ? `[${typeName(t.ofType)}]` : t.name ?? "?");
const baseName = (t: TypeRef | null | undefined): string | null => (!t ? null : t.name ?? baseName(t.ofType));

export interface SchemaField { name: string; type: string; description: string | null; values?: string[] }
export interface SchemaReport { operations: { name: string; description: string | null; args: SchemaField[] }[]; types: { name: string; description: string | null; fields: SchemaField[] }[]; matches: string[] }

/**
 * Asks Redo's GraphQL API to describe its shipping operations and every input they take (GraphQL introspection),
 * so options the guide doesn't mention — like signature confirmation — can be found. Read-only.
 */
export async function redoSchema(env: Env, look = /signat|confirm|adult|insur|option|service|extra|delivery/i): Promise<SchemaReport> {
  const top = await gql<{ __schema: { mutationType: { fields: { name: string; description: string | null; args: { name: string; description: string | null; type: TypeRef }[] }[] } | null; queryType: { fields: { name: string }[] } | null } }>(env, () =>
    `query { __schema { mutationType { fields { name description args { name description type { ${TYPE_REF} } } } } queryType { fields { name } } } }`);
  const ops = (top.__schema.mutationType?.fields ?? []).filter((f) => /ship|label|carrier|quote|rate/i.test(f.name));
  const seen = new Set<string>();
  const types: SchemaReport["types"] = [];
  let queue = ops.flatMap((o) => o.args.map((a) => baseName(a.type))).filter((n): n is string => !!n);
  for (let depth = 0; depth < 5 && queue.length; depth++) {
    const names = [...new Set(queue)].filter((n) => !seen.has(n) && !/^(String|Int|Float|Boolean|ID)$/.test(n)).slice(0, 30);
    names.forEach((n) => seen.add(n));
    if (!names.length) break;
    const data = await gql<Record<string, { name: string; kind: string; description: string | null; inputFields: { name: string; description: string | null; type: TypeRef }[] | null; enumValues: { name: string }[] | null } | null>>(env, () =>
      `query { ${names.map((n, i) => `t${i}: __type(name: ${JSON.stringify(n)}) { name kind description inputFields { name description type { ${TYPE_REF} } } enumValues { name } }`).join(" ")} }`);
    queue = [];
    for (const t of Object.values(data)) {
      if (!t) continue;
      const fields = t.kind === "ENUM"
        ? [{ name: "(values)", type: "enum", description: null, values: (t.enumValues ?? []).map((v) => v.name) }]
        : (t.inputFields ?? []).map((f) => ({ name: f.name, type: typeName(f.type), description: f.description }));
      types.push({ name: t.name, description: t.description, fields });
      for (const f of t.inputFields ?? []) { const b = baseName(f.type); if (b) queue.push(b); }
    }
  }
  const matches = types.flatMap((t) => t.fields.filter((f) => look.test(`${f.name} ${f.description ?? ""} ${(f.values ?? []).join(" ")}`)).map((f) => `${t.name}.${f.name}${f.values ? `: ${f.values.join(", ")}` : ` (${f.type})`}`));
  return { operations: ops.map((o) => ({ name: o.name, description: o.description, args: o.args.map((a) => ({ name: a.name, type: typeName(a.type), description: a.description })) })), types, matches };
}
