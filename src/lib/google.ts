import type { Env } from "../env";
import { HttpError, base64UrlDecode } from "./util";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export function redirectUri(requestUrl: string) {
  return new URL("/auth/google/callback", requestUrl).toString();
}

export function googleAuthUrl(
  env: Env,
  requestUrl: string,
  state: string,
  opts: { mailbox: boolean },
): string {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(500, "GOOGLE_CLIENT_ID is not configured");
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(requestUrl),
    response_type: "code",
    state,
    scope: opts.mailbox ? `openid email profile ${GMAIL_SCOPE}` : "openid email profile",
  });
  if (opts.mailbox) {
    p.set("access_type", "offline");
    p.set("prompt", "consent");
    p.set("login_hint", env.SUPPORT_EMAIL);
  } else {
    p.set("prompt", "select_account");
  }
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export async function exchangeCode(env: Env, requestUrl: string, code: string): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(requestUrl),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new HttpError(502, "Google sign-in failed: " + (await res.text()));
  return res.json();
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new HttpError(502, "Could not refresh Gmail access: " + (await res.text()));
  return res.json();
}

/** Decode the id_token payload. It came straight from Google's token endpoint over TLS, so no signature check is needed. */
export function idTokenClaims(idToken: string): { email: string; email_verified: boolean; name?: string; aud: string } {
  return JSON.parse(base64UrlDecode(idToken.split(".")[1]));
}
