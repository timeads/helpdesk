// Customs for international shipments: item list from the order, remembered per product, plus defaults.
import type { Env } from "../env";
import type { ShopifyOrder } from "./shopify";
import { getSetting } from "./util";

export interface CustomsItem {
  productKey: string;
  lineId?: string;
  description: string; // plain-language, max 35 characters for UPS
  hsCode: string;
  origin: string; // ISO country of manufacture
  qty: number;
  unitValue: number; // USD
  unitWeightLb: number;
}

export interface Customs {
  contents: "merchandise" | "gift" | "sample" | "returned_goods" | "documents" | "other";
  dutiesPaidBy: "recipient" | "sender";
  nonDelivery: "return" | "abandon";
  signer: string;
  items: CustomsItem[];
}

export interface CustomsSettings {
  description: string;
  hsCode: string;
  origin: string;
  signer: string;
  taxId: string; // EIN / tax ID printed on commercial invoices
  contents: Customs["contents"];
  dutiesPaidBy: Customs["dutiesPaidBy"];
  nonDelivery: Customs["nonDelivery"];
}

export const DEFAULT_CUSTOMS: CustomsSettings = {
  description: "Rug tufting supplies",
  hsCode: "",
  origin: "US",
  signer: "",
  taxId: "",
  contents: "merchandise",
  dutiesPaidBy: "recipient",
  nonDelivery: "return",
};

export const customsSettings = async (env: Env): Promise<CustomsSettings> => ({ ...DEFAULT_CUSTOMS, ...(await getSetting<Partial<CustomsSettings>>(env, "customs", {})) });

const productKey = (l: { sku: string | null; title: string; variantTitle: string | null }) =>
  (l.sku || `${l.title}${l.variantTitle ? " / " + l.variantTitle : ""}`).toLowerCase();
const WEIGHT_TO_LB: Record<string, number> = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 };

export async function loadProfiles(env: Env, keys: string[]) {
  const map = new Map<string, { description: string; hs_code: string; origin: string }>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT * FROM customs_profiles WHERE product_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<any>();
    for (const r of results) map.set(r.product_key, r);
  }
  return map;
}

/** Customs for an order: Shopify's HS code/origin first, then what was entered last time, then the defaults. */
export async function buildCustoms(env: Env, o: ShopifyOrder): Promise<Customs> {
  const settings = await customsSettings(env);
  const profiles = await loadProfiles(env, o.lineItems.nodes.map(productKey));
  return {
    contents: settings.contents,
    dutiesPaidBy: settings.dutiesPaidBy,
    nonDelivery: settings.nonDelivery,
    signer: settings.signer,
    items: o.lineItems.nodes.map((l) => {
      const p = profiles.get(productKey(l));
      const inv = l.variant?.inventoryItem;
      const w = inv?.measurement?.weight;
      return {
        productKey: productKey(l),
        lineId: l.id,
        description: (p?.description || l.title || settings.description).slice(0, 35),
        hsCode: (inv?.harmonizedSystemCode || p?.hs_code || settings.hsCode || "").replace(/\D/g, ""),
        origin: (inv?.countryCodeOfOrigin || p?.origin || settings.origin || "US").toUpperCase(),
        qty: l.quantity,
        unitValue: Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney.amount ?? 0),
        unitWeightLb: w && w.value > 0 ? w.value * (WEIGHT_TO_LB[w.unit] ?? 1) : 0,
      };
    }),
  };
}

/** Remembers each product's customs description, HS code and origin for next time. */
export async function saveProfiles(env: Env, c: Customs) {
  for (const i of c.items) {
    if (!i.productKey || !i.description.trim()) continue;
    await env.DB.prepare(
      `INSERT INTO customs_profiles (product_key, description, hs_code, origin, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(product_key) DO UPDATE SET description = excluded.description, hs_code = excluded.hs_code, origin = excluded.origin, updated_at = excluded.updated_at`,
    ).bind(i.productKey, i.description.trim().slice(0, 35), i.hsCode.replace(/\D/g, ""), (i.origin || "US").toUpperCase().slice(0, 2)).run();
  }
}

export const customsTotal = (c: Customs) => Math.round(c.items.reduce((n, i) => n + i.qty * i.unitValue, 0) * 100) / 100;

/** Problems that would make a carrier reject the shipment (or need an export filing). */
export function customsProblems(c: Customs): string[] {
  const out: string[] = [];
  if (!c.items.length) out.push("Add at least one item to the customs list");
  c.items.forEach((i, n) => {
    if (!i.description.trim()) out.push(`Item ${n + 1} needs a description`);
    if (!(i.qty > 0)) out.push(`Item ${n + 1} needs a quantity`);
    if (i.hsCode && !/^\d{6,10}$/.test(i.hsCode)) out.push(`Item ${n + 1}: HS code should be 6–10 digits`);
  });
  // Export filing (EEI/AES) is required above $2,500 per HS code
  const byCode = new Map<string, number>();
  for (const i of c.items) byCode.set(i.hsCode || "?", (byCode.get(i.hsCode || "?") ?? 0) + i.qty * i.unitValue);
  for (const [code, v] of byCode) if (v > 2500) out.push(`Items under HS ${code} total $${v.toFixed(2)} — over $2,500 needs an export filing (AES) before shipping`);
  return out;
}

/** Valid customs from the browser, cleaned. */
export function cleanCustoms(raw: any): Customs | undefined {
  if (!raw || !Array.isArray(raw.items)) return undefined;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  return {
    contents: pick(raw.contents, ["merchandise", "gift", "sample", "returned_goods", "documents", "other"] as const, "merchandise"),
    dutiesPaidBy: pick(raw.dutiesPaidBy, ["recipient", "sender"] as const, "recipient"),
    nonDelivery: pick(raw.nonDelivery, ["return", "abandon"] as const, "return"),
    signer: String(raw.signer ?? "").slice(0, 60),
    items: raw.items.slice(0, 100).map((i: any) => ({
      productKey: String(i.productKey ?? "").slice(0, 200),
      lineId: i.lineId ? String(i.lineId) : undefined,
      description: String(i.description ?? "").slice(0, 35),
      hsCode: String(i.hsCode ?? "").replace(/\D/g, "").slice(0, 10),
      origin: String(i.origin ?? "US").toUpperCase().slice(0, 2),
      qty: Math.max(0, Math.round(Number(i.qty) || 0)),
      unitValue: Math.max(0, Number(i.unitValue) || 0),
      unitWeightLb: Math.max(0, Number(i.unitWeightLb) || 0),
    })),
  };
}
