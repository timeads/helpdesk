import type { Env } from "../env";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const nowIso = () => new Date().toISOString();

export function randomId(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(buf);
}

export function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecodeBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlDecode(s: string): string {
  return new TextDecoder().decode(base64UrlDecodeBytes(s));
}

// ---- Settings (JSON values in the settings table) ----

export async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(env: Env, key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

// ---- Encryption for stored refresh tokens (AES-GCM, key derived from SESSION_SECRET) ----

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET) throw new HttpError(500, "SESSION_SECRET is not set");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("helpdesk-enc:" + env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain));
  return base64UrlEncode(iv) + "." + base64UrlEncode(new Uint8Array(ct));
}

export async function decrypt(env: Env, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecodeBytes(iv) },
    await aesKey(env),
    base64UrlDecodeBytes(ct),
  );
  return new TextDecoder().decode(pt);
}

// ---- Cached OAuth access tokens (shared by Gmail, Shopify, UPS) ----

export async function cachedToken(
  env: Env,
  key: string,
  fetchToken: () => Promise<{ token: string; expiresIn: number }>,
): Promise<string> {
  const cached = await getSetting<{ token: string; exp: number } | null>(env, key, null);
  if (cached && cached.exp > Date.now() + 60_000) return decrypt(env, cached.token);
  const { token, expiresIn } = await fetchToken();
  await setSetting(env, key, { token: await encrypt(env, token), exp: Date.now() + expiresIn * 1000 });
  return token;
}

export function parseAddress(raw: string): { email: string; name: string | null } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}

export function splitAddressList(raw: string): string[] {
  // Split on commas that are not inside quotes
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The real type of a base64 image from its first bytes. Email attachments are often labelled
 * wrong (a JPEG sent as "image/png"), and the AI rejects a mismatch. Null when it isn't one we know.
 */
export function sniffImageType(base64: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  let head: string;
  try {
    const start = base64.slice(0, 24).replace(/-/g, "+").replace(/_/g, "/");
    head = atob(start.slice(0, start.length - (start.length % 4)));
  } catch {
    return null;
  }
  const b = (i: number) => head.charCodeAt(i);
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}
