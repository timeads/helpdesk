// Per-order choices saved from the order page as they're made, so moving between orders (or a
// bulk "Buy labels" later) keeps the boxes, split, service and address someone picked.
import type { Env } from "../env";
import type { Address, Signature } from "./ups";
import type { Plan, Preset } from "./fulfillment";
import { cleanCustoms, type Customs } from "./customs";

export interface DraftBox {
  presetId: number | null;
  length: number;
  width: number;
  height: number;
  weight: number | null;
  items: Record<string, number>;
}

export interface OrderDraft {
  boxes: DraftBox[];
  signature: Signature | "none"; // "none": no signature, even when a rule asks for one
  service: string | null;
  to: Address | null;
  customs?: Customs | null; // edited customs list (international): values, descriptions, HS codes
}

const num = (v: unknown, max = 500) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n * 100) / 100) : 0;
};
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);

/** Validates a draft from the browser. Returns null when there's nothing usable. */
export function cleanDraft(input: any): OrderDraft | null {
  if (!input || typeof input !== "object" || !Array.isArray(input.boxes) || !input.boxes.length) return null;
  const boxes: DraftBox[] = input.boxes.slice(0, 20).map((b: any) => ({
    presetId: Number.isInteger(Number(b?.presetId)) && Number(b.presetId) > 0 ? Number(b.presetId) : null,
    length: num(b?.length, 200),
    width: num(b?.width, 200),
    height: num(b?.height, 200),
    weight: num(b?.weight, 1000) || null,
    items: Object.fromEntries(
      Object.entries(b?.items && typeof b.items === "object" ? b.items : {})
        .filter(([k]) => typeof k === "string" && k.length < 120)
        .map(([k, v]) => [k, Math.max(0, Math.min(10_000, Math.round(Number(v) || 0)))]),
    ),
  }));
  const a = input.to;
  const to: Address | null = a && typeof a === "object" && a.address1
    ? {
        name: str(a.name, 80), company: str(a.company, 80), phone: str(a.phone, 30), address1: str(a.address1, 100), address2: str(a.address2, 100),
        city: str(a.city, 60), state: str(a.state, 10), zip: str(a.zip, 15), country: str(a.country || "US", 2).toUpperCase(), residential: a.residential !== false,
      }
    : null;
  return {
    boxes,
    signature: input.signature === "adult" || input.signature === "standard" || input.signature === "none" ? input.signature : undefined,
    service: typeof input.service === "string" && input.service.length < 80 ? input.service : null,
    to,
    customs: cleanCustoms(input.customs) ?? null,
  };
}

export async function loadDrafts(env: Env, ids: string[]): Promise<Map<string, OrderDraft>> {
  const out = new Map<string, OrderDraft>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT order_id, data FROM order_drafts WHERE order_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ order_id: string; data: string }>();
    for (const r of results) {
      try {
        const d = cleanDraft(JSON.parse(r.data));
        if (d) out.set(r.order_id, d);
      } catch { /* ignore a broken row */ }
    }
  }
  return out;
}

export const saveDraft = (env: Env, orderId: string, d: OrderDraft) =>
  env.DB.prepare(
    `INSERT INTO order_drafts (order_id, data, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(order_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(orderId, JSON.stringify(d)).run();

export const deleteDraft = (env: Env, orderId: string) => env.DB.prepare("DELETE FROM order_drafts WHERE order_id = ?").bind(orderId).run();

/** The plan with the saved choices on top: same boxes, split, weights, service and signature. */
export function applyDraft(plan: Plan, d: OrderDraft, presets: Preset[], lineIds: string[]): Plan {
  const boxes = d.boxes.map((b) => {
    const preset = presets.find((p) => p.id === b.presetId) ?? null;
    const items = Object.fromEntries(lineIds.map((id) => [id, b.items[id] ?? 0]));
    return { preset, parcel: { length: b.length, width: b.width, height: b.height, weight: b.weight ?? 0 }, items };
  });
  // Lines added to the order after the draft was saved go in the first box
  for (const id of lineIds) {
    const placed = boxes.reduce((n, b) => n + (b.items[id] ?? 0), 0);
    const want = plan.boxes.reduce((n, b) => n + (b.items[id] ?? 0), 0);
    if (!placed && want) boxes[0].items[id] = want;
  }
  const weightKnown = d.boxes.every((b) => (b.weight ?? 0) > 0);
  return {
    ...plan,
    preset: boxes[0].preset,
    parcel: boxes[0].parcel,
    parcels: boxes.map((b) => b.parcel),
    boxes,
    totalWeight: Math.round(boxes.reduce((n, b) => n + b.parcel.weight, 0) * 10) / 10,
    weightKnown,
    source: "saved",
    signature: d.signature === "none" ? null : d.signature ?? plan.signature,
    signatureFrom: d.signature === "none" ? "saved-none" : d.signature ? "saved" : plan.signatureFrom,
    service: d.service ?? plan.service,
  };
}
