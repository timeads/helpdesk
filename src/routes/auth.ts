import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { createSession, currentAgent, destroySession, findOrProvisionAgent } from "../lib/auth";
import { exchangeCode, googleAuthUrl, idTokenClaims } from "../lib/google";
import { getMailbox } from "../lib/gmail";
import { deleteSetting, encrypt, nowIso, randomId, setSetting } from "../lib/util";

const auth = new Hono<AppEnv>();
const STATE_COOKIE = "hd_oauth_state";

function startFlow(c: any, purpose: "login" | "mailbox") {
  const state = `${purpose}.${randomId(16)}`;
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  return c.redirect(googleAuthUrl(c.env, c.req.url, state, { mailbox: purpose === "mailbox" }));
}

auth.get("/login", (c) => startFlow(c, "login"));

auth.get("/mailbox", async (c) => {
  const agent = await currentAgent(c);
  if (!agent || agent.role !== "admin") return c.redirect("/?error=" + encodeURIComponent("Only admins can connect the mailbox"));
  return startFlow(c, "mailbox");
});

auth.get("/google/callback", async (c) => {
  const fail = (msg: string) => c.redirect("/?error=" + encodeURIComponent(msg));
  const state = c.req.query("state") ?? "";
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  if (!expected || state !== expected) return fail("Sign-in expired — please try again.");
  if (c.req.query("error")) return fail("Google sign-in was cancelled.");

  const tokens = await exchangeCode(c.env, c.req.url, c.req.query("code") ?? "");
  if (!tokens.id_token) return fail("Google did not return an identity.");
  const claims = idTokenClaims(tokens.id_token);
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.email_verified) return fail("Unverified Google account.");

  if (state.startsWith("mailbox.")) {
    const agent = await currentAgent(c);
    if (!agent || agent.role !== "admin") return fail("Only admins can connect the mailbox.");
    if (claims.email.toLowerCase() !== c.env.SUPPORT_EMAIL.toLowerCase()) {
      return fail(`Please choose ${c.env.SUPPORT_EMAIL} on the Google screen (you picked ${claims.email}).`);
    }
    if (!tokens.refresh_token) return fail("Google did not grant offline access. Remove the app at myaccount.google.com/permissions and try again.");
    const previous = await getMailbox(c.env);
    await setSetting(c.env, "mailbox", {
      email: claims.email.toLowerCase(),
      refreshToken: await encrypt(c.env, tokens.refresh_token),
      historyId: previous?.email === claims.email.toLowerCase() ? previous.historyId : undefined,
      connectedAt: nowIso(),
      lastError: null,
    });
    await deleteSetting(c.env, "mailbox_access");
    return c.redirect("/settings?connected=gmail");
  }

  const agent = await findOrProvisionAgent(c.env, claims.email, claims.name ?? "");
  if (!agent) return fail(`${claims.email} isn't on the team yet. Ask an admin to add you in Settings.`);
  await createSession(c, agent.id);
  return c.redirect("/");
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

export default auth;
