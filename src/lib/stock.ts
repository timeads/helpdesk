// What's on order and when it's expected, from the TuftStock app (read-only), for restock questions
// in the chat and the learn hub's Ask box. TuftStock leaves out suppliers and costs; this adds which
// products are sold out on the store right now.
import type { Env } from "../env";
import { HttpError, getSetting, setSetting } from "./util";

export interface IncomingRow {
  shopifyVariantId: string;
  shopifyProductId: string;
  title: string;
  option: string | null;
  sku: string | null;
  onHand: number;
  incoming: number;
  stage: "ordered" | "shipped" | "arrived";
  expected: string | null; // YYYY-MM-DD
  late: boolean;
}

export const stockConfigured = (env: Env) => !!(env.TUFTSTOCK_URL?.trim() && env.TUFTSTOCK_TOKEN?.trim());

export async function fetchIncoming(env: Env): Promise<IncomingRow[]> {
  const base = env.TUFTSTOCK_URL!.trim().replace(/\/+$/, "");
  const r = await fetch(`${base}/api/incoming`, { headers: { authorization: `Bearer ${env.TUFTSTOCK_TOKEN!.trim()}`, accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new HttpError(502, "TuftStock turned down the token — check HELPDESK_API_TOKEN in TuftStock matches the one here");
  if (r.status === 404) throw new HttpError(502, "TuftStock doesn't have the incoming-stock endpoint yet — deploy the latest TuftStock");
  if (r.status === 503) throw new HttpError(502, "TuftStock doesn't see HELPDESK_API_TOKEN — add it to the TuftStock web service's variables in Railway and redeploy");
  if (!r.ok) throw new HttpError(502, `TuftStock answered ${r.status}`);
  const d = (await r.json()) as { items?: IncomingRow[] };
  return Array.isArray(d.items) ? d.items : [];
}

/** Incoming stock, refreshed every 15 minutes; empty when TuftStock isn't connected or is down. */
export async function incomingStock(env: Env): Promise<IncomingRow[]> {
  if (!stockConfigured(env)) return [];
  const hit = await getSetting<{ at: number; data: IncomingRow[] } | null>(env, "incoming_stock", null);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.data;
  try {
    const data = await fetchIncoming(env);
    await setSetting(env, "incoming_stock", { at: Date.now(), data });
    return data;
  } catch {
    return hit?.data ?? [];
  }
}

const RESTOCK = /\b(stock|restock|re-stock|back in|sold ?out|out of|available|availability|in store|when (?:will|is|are|do|does)\b.*\b(?:come|coming|arriv|ship|back|get|have))/i;
/** Whether a question is (probably) about availability, so the chat only loads stock when it helps. */
export const asksAboutStock = (text: string) => RESTOCK.test(text);

const fmt = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** The block the AI reads: sold-out items, what's on order for them (and anything else incoming), and how to talk about it. */
export function stockText(rows: IncomingRow[], soldOut: { title: string; options: string[] }[]): string {
  const name = (r: { title: string; option: string | null }) => (r.option && r.option !== "Default Title" ? `${r.title} — ${r.option}` : r.title);
  const incoming = rows.map((r) => {
    const when = r.stage === "arrived" ? "arrived at our studio, being checked in (usually on sale within a few days)"
      : r.late ? `${r.stage === "shipped" ? "shipped" : "ordered"}, running behind (was due ${fmt(r.expected!)}; no firm new date)`
        : r.expected ? `${r.stage === "shipped" ? "shipped, on its way" : "ordered"}, expected at our studio around ${fmt(r.expected)}`
          : `${r.stage === "shipped" ? "shipped" : "ordered"}, no date yet`;
    return `- ${name(r)}: ${r.onHand > 0 ? `${r.onHand} in stock now` : "out of stock"}; ${r.incoming} more ${when}`;
  });
  const out = soldOut.map((p) => `- ${p.title}${p.options.length ? ` (sold out: ${p.options.slice(0, 12).join(", ")})` : " (sold out)"}`);
  if (!incoming.length && !out.length) return "";
  return [
    out.length ? `Sold out on the store right now:\n${out.join("\n")}` : "",
    incoming.length ? `On order (restocks):\n${incoming.join("\n")}` : "",
    `How to talk about restocks: give the date as approximate ("around October 9"), and say it usually takes a few days after arriving at our studio to go back on sale. Dates can slip, so never promise one. If something is sold out and not on order, say we don't have a restock date yet and suggest the chat or email for updates or an alternative. Never mention suppliers, costs or quantities we ordered.`,
  ].filter(Boolean).join("\n\n");
}
