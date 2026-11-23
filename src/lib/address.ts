// Ship-to address verification: UPS Address Validation when UPS is live, else EasyPost; cached per address.
import type { Env } from "../env";
import { upsConfigured, validateAddressUps, type Address, type AddressCheck } from "./ups";
import { easypostConfigured, verifyAddressEasypost } from "./easypost";

const UNCHECKED = (message: string): AddressCheck => ({ status: "unchecked", residential: null, suggestion: null, provider: null, message });

async function hashOf(a: Address) {
  const key = [a.address1, a.address2, a.city, a.state, (a.zip ?? "").slice(0, 5), a.country].map((s) => (s ?? "").toUpperCase().replace(/\s+/g, " ").trim()).join("|");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function verifierAvailable(env: Env): "UPS" | "EasyPost" | null {
  // UPS's test environment only answers for a couple of states, so it's only trusted in production
  if (upsConfigured(env) && env.UPS_ENV === "production") return "UPS";
  if (easypostConfigured(env)) return "EasyPost";
  return null;
}

export async function checkAddress(env: Env, a: Address, { fresh = false } = {}): Promise<AddressCheck> {
  const country = (a.country || "US").toUpperCase();
  if (!["US", "PR"].includes(country)) return UNCHECKED("International addresses aren't checked yet");
  if (!a.address1 || !a.city || !a.zip) return { status: "invalid", residential: null, suggestion: null, provider: null, message: "The address is incomplete" };
  const hash = await hashOf(a);
  const row = await env.DB.prepare("SELECT result FROM address_checks WHERE hash = ?").bind(hash).first<{ result: string }>();
  const cached = row ? (JSON.parse(row.result) as AddressCheck & { trusted?: boolean }) : null;
  // An address the team marked correct (or shipped to anyway) stays good, even on "Check again"
  if (cached && (!fresh || cached.trusted)) return cached;
  const provider = verifierAvailable(env);
  if (!provider) return UNCHECKED(upsConfigured(env) ? "Address checks start when UPS is switched to production" : "Connect UPS or EasyPost to check addresses");
  let result: AddressCheck;
  try {
    result = provider === "UPS" ? await validateAddressUps(env, a) : await verifyAddressEasypost(env, a);
  } catch (e) {
    const msg = (e as Error).message;
    // Not cached, so it's tried again later
    return UNCHECKED(/not authorized|access|product/i.test(msg) && provider === "UPS"
      ? "Add “Address Validation” to your UPS developer app to check addresses"
      : `Couldn't check the address: ${msg.slice(0, 160)}`);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO address_checks (hash, result, checked_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .bind(hash, JSON.stringify(result))
    .run();
  return result;
}

/**
 * The team knows this address is right although the carrier couldn't confirm it (a new building, an
 * apartment the database doesn't list…): remember it as good, so it never blocks a label again.
 */
export async function trustAddress(env: Env, a: Address, by: string): Promise<AddressCheck> {
  const result = {
    status: "valid", residential: a.residential ?? null, suggestion: null, provider: null, trusted: true,
    message: `Marked correct by ${by} — the carrier couldn't confirm it`,
  } as AddressCheck & { trusted: true };
  await env.DB.prepare("INSERT OR REPLACE INTO address_checks (hash, result, checked_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .bind(await hashOf(a), JSON.stringify(result))
    .run();
  return result;
}

/** A label was bought to an address the carrier had flagged (the team chose to go ahead): it's good from now on. */
export async function rememberShippedAddress(env: Env, a: Address, by: string) {
  if (!["US", "PR"].includes((a.country || "US").toUpperCase())) return;
  const row = await env.DB.prepare("SELECT result FROM address_checks WHERE hash = ?").bind(await hashOf(a)).first<{ result: string }>();
  if (!row) return;
  const r = JSON.parse(row.result) as AddressCheck;
  if (r.status !== "valid") await trustAddress(env, a, by);
}
