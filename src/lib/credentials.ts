// Integration credentials entered in Settings. Stored encrypted in D1 and layered over Worker env vars,
// so the app works whether a key was set in Cloudflare or pasted into the app.
import type { Env } from "../env";
import { decrypt, deleteSetting, encrypt, getSetting, setSetting } from "./util";

export interface CredentialField {
  key: keyof Env & string;
  label: string;
  group: "shopify" | "ups" | "usps" | "ai" | "booking" | "stock";
  secret: boolean; // never sent back to the browser
  options?: string[];
  placeholder?: string;
  help?: string;
}

export const CREDENTIAL_FIELDS: CredentialField[] = [
  { key: "SHOPIFY_SHOP", label: "Store address", group: "shopify", secret: false, placeholder: "tufttheworld.myshopify.com" },
  { key: "SHOPIFY_CLIENT_ID", label: "Client ID", group: "shopify", secret: false, help: "Dev Dashboard apps" },
  { key: "SHOPIFY_CLIENT_SECRET", label: "Client secret", group: "shopify", secret: true, help: "Dev Dashboard apps" },
  { key: "SHOPIFY_ADMIN_TOKEN", label: "Admin API access token", group: "shopify", secret: true, placeholder: "shpat_…", help: "Older custom apps: use this instead of Client ID + secret" },
  { key: "UPS_CLIENT_ID", label: "Client ID", group: "ups", secret: false },
  { key: "UPS_CLIENT_SECRET", label: "Client secret", group: "ups", secret: true },
  { key: "UPS_ACCOUNT_NUMBER", label: "UPS account number", group: "ups", secret: false, placeholder: "6 characters" },
  { key: "UPS_ENV", label: "Mode", group: "ups", secret: false, options: ["test", "production"] },
  { key: "EASYPOST_API_KEY", label: "EasyPost production API key", group: "usps", secret: true, placeholder: "EZAK…", help: "EasyPost → Account → API Keys → Production" },
  { key: "BOOKING_SUPABASE_URL", label: "Project URL", group: "booking", secret: false, placeholder: "https://….supabase.co", help: "Supabase → Project settings → API (the booking app's VITE_SUPABASE_URL)" },
  { key: "BOOKING_SUPABASE_ANON_KEY", label: "Anon (public) key", group: "booking", secret: true, placeholder: "eyJ…", help: "Same page, the anon public key (VITE_SUPABASE_ANON_KEY) — read-only, the same one the date picker uses" },
  { key: "TUFTSTOCK_URL", label: "TuftStock address", group: "stock", secret: false, placeholder: "https://tuftstock-….up.railway.app", help: "The address you open TuftStock at" },
  { key: "TUFTSTOCK_TOKEN", label: "Helpdesk token", group: "stock", secret: true, help: "The same value as HELPDESK_API_TOKEN in TuftStock's Railway variables" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", group: "ai", secret: true, placeholder: "sk-ant-…" },
  { key: "AI_MODEL", label: "Model", group: "ai", secret: false, options: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] },
];

const STORE_KEY = "credentials";
const TOKEN_CACHES: Record<CredentialField["group"], string[]> = {
  shopify: ["shopify_access"],
  ups: ["ups_access_test", "ups_access_production"],
  usps: [],
  booking: ["ask_classes"],
  stock: ["incoming_stock"],
  ai: [],
};

type Stored = Record<string, string>; // key -> encrypted value

/** Env with app-entered credentials applied on top. Called once per request and per cron run. */
export async function withCredentials(env: Env): Promise<Env> {
  let stored: Stored = {};
  try {
    stored = await getSetting<Stored>(env, STORE_KEY, {});
  } catch {
    return env; // database not migrated yet
  }
  const keys = Object.keys(stored);
  if (!keys.length || !env.SESSION_SECRET) return env;
  // Prototype-chain over the real env instead of spreading it: spreading can drop bindings
  // that aren't own-enumerable (Cloudflare secrets), which made SESSION_SECRET vanish.
  const merged: Record<string, unknown> = Object.create(env);
  for (const k of keys) {
    try {
      merged[k] = await decrypt(env, stored[k]);
    } catch {
      /* SESSION_SECRET changed — ignore the unreadable value */
    }
  }
  return merged as unknown as Env;
}

export async function describeCredentials(rawEnv: Env) {
  const stored = await getSetting<Stored>(rawEnv, STORE_KEY, {});
  const merged = await withCredentials(rawEnv);
  return CREDENTIAL_FIELDS.map((f) => {
    const value = (merged as any)[f.key] as string | undefined;
    const source = stored[f.key] ? "app" : (rawEnv as any)[f.key] ? "cloudflare" : null;
    return {
      ...f,
      set: !!value,
      source,
      value: f.secret ? null : value ?? "",
      hint: f.secret && value ? `…${value.slice(-4)}` : null,
    };
  });
}

/** Save values for one group. Empty string clears an app-entered value; undefined leaves it alone. */
export async function saveCredentials(env: Env, values: Record<string, string | undefined>) {
  const stored = await getSetting<Stored>(env, STORE_KEY, {});
  const touched = new Set<CredentialField["group"]>();
  for (const f of CREDENTIAL_FIELDS) {
    const v = values[f.key];
    if (v === undefined) continue;
    const trimmed = v.trim();
    if (f.options && trimmed && !f.options.includes(trimmed)) continue;
    if (trimmed) stored[f.key] = await encrypt(env, f.key === "SHOPIFY_SHOP" ? normalizeShop(trimmed) : trimmed);
    else delete stored[f.key];
    touched.add(f.group);
  }
  await setSetting(env, STORE_KEY, stored);
  for (const g of touched) for (const k of TOKEN_CACHES[g]) await deleteSetting(env, k);
}

export function normalizeShop(v: string) {
  const host = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return host.includes(".") ? host : `${host}.myshopify.com`;
}
