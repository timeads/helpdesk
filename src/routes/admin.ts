import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { DEFAULT_RULES, getMailbox, type MailRules } from "../lib/gmail";
import { shopifyConfigured } from "../lib/shopify";
import { upsConfigured } from "../lib/ups";
import { aiConfigured } from "../lib/ai";
import { HttpError, deleteSetting, getSetting, setSetting } from "../lib/util";
import { CREDENTIAL_FIELDS, describeCredentials, saveCredentials, withCredentials } from "../lib/credentials";
import { shopify } from "../lib/shopify";
import { testUps } from "../lib/ups";
import Anthropic from "@anthropic-ai/sdk";

const admin = new Hono<AppEnv>();

admin.get("/me", (c) => c.json({ agent: c.get("agent"), appName: c.env.APP_NAME }));

admin.patch("/me", async (c) => {
  const body = await c.req.json<{ name?: string; signature?: string }>();
  const me = c.get("agent");
  await c.env.DB.prepare("UPDATE agents SET name = COALESCE(?, name), signature = COALESCE(?, signature) WHERE id = ?")
    .bind(body.name?.trim() || null, body.signature ?? null, me.id)
    .run();
  return c.json({ ok: true });
});

admin.get("/agents", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, email, name, role FROM agents WHERE active = 1 ORDER BY name").all();
  return c.json({ agents: results });
});

admin.post("/agents", async (c) => {
  requireAdmin(c);
  const { email, name, role } = await c.req.json<{ email: string; name: string; role?: string }>();
  if (!/^[^@\s]+@[^@\s]+$/.test(email ?? "")) throw new HttpError(400, "Enter a valid email");
  await c.env.DB.prepare(
    `INSERT INTO agents (email, name, role) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET active = 1, name = excluded.name, role = excluded.role`,
  )
    .bind(email.trim().toLowerCase(), name?.trim() || email.split("@")[0], role === "admin" ? "admin" : "agent")
    .run();
  return c.json({ ok: true });
});

admin.delete("/agents/:id{[0-9]+}", async (c) => {
  requireAdmin(c);
  const id = Number(c.req.param("id"));
  if (id === c.get("agent").id) throw new HttpError(400, "You can't remove yourself");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE agents SET active = 0 WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sessions WHERE agent_id = ?").bind(id),
    c.env.DB.prepare("UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ? AND status != 'closed'").bind(id),
  ]);
  return c.json({ ok: true });
});

admin.get("/macros", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, body FROM macros ORDER BY name").all();
  return c.json({ macros: results });
});

admin.post("/macros", async (c) => {
  const { name, body } = await c.req.json<{ name: string; body: string }>();
  if (!name?.trim() || !body?.trim()) throw new HttpError(400, "A saved reply needs a name and text");
  await c.env.DB.prepare("INSERT INTO macros (name, body) VALUES (?, ?)").bind(name.trim(), body.trim()).run();
  return c.json({ ok: true });
});

admin.put("/macros/:id{[0-9]+}", async (c) => {
  const { name, body } = await c.req.json<{ name: string; body: string }>();
  await c.env.DB.prepare("UPDATE macros SET name = ?, body = ? WHERE id = ?").bind(name.trim(), body.trim(), Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

admin.delete("/macros/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM macros WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

admin.get("/settings", async (c) => {
  const box = await getMailbox(c.env);
  return c.json({
    integrations: {
      gmail: box
        ? { connected: true, email: box.email, lastSyncAt: box.lastSyncAt ?? null, lastError: box.lastError ?? null }
        : { connected: false, configured: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET), email: c.env.SUPPORT_EMAIL },
      shopify: { connected: shopifyConfigured(c.env), shop: c.env.SHOPIFY_SHOP },
      ups: { connected: upsConfigured(c.env), env: c.env.UPS_ENV },
      ai: { connected: aiConfigured(c.env), model: c.env.AI_MODEL },
    },
    signature: await getSetting(c.env, "signature", ""),
    mailRules: { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(c.env, "mail_rules", {})) },
    shipFrom: await getSetting(c.env, "ship_from", null),
    aiGuidance: await getSetting(c.env, "ai_guidance", ""),
  });
});

admin.put("/settings", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<{ signature?: string; mailRules?: Partial<MailRules>; shipFrom?: unknown; aiGuidance?: string }>();
  if (body.signature !== undefined) await setSetting(c.env, "signature", body.signature);
  if (body.mailRules) {
    const r = body.mailRules;
    await setSetting(c.env, "mail_rules", {
      blockedSenders: (r.blockedSenders ?? []).map((s) => s.trim()).filter(Boolean),
      skipAutomated: r.skipAutomated ?? true,
      archiveOnClose: r.archiveOnClose ?? true,
      importDays: Math.min(90, Math.max(1, Number(r.importDays) || 14)),
    });
  }
  if (body.shipFrom !== undefined) await setSetting(c.env, "ship_from", body.shipFrom);
  if (body.aiGuidance !== undefined) await setSetting(c.env, "ai_guidance", body.aiGuidance);
  return c.json({ ok: true });
});

admin.get("/credentials", async (c) => {
  requireAdmin(c);
  return c.json({ fields: await describeCredentials(c.env.RAW_ENV ?? c.env) });
});

admin.put("/credentials", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<Record<string, string>>();
  const allowed = new Set(CREDENTIAL_FIELDS.map((f) => f.key as string));
  const values = Object.fromEntries(Object.entries(body).filter(([k, v]) => allowed.has(k) && typeof v === "string"));
  await saveCredentials(c.env.RAW_ENV ?? c.env, values);
  return c.json({ fields: await describeCredentials(c.env.RAW_ENV ?? c.env) });
});

/** Checks the saved credentials for one service with a harmless read-only call. */
admin.post("/credentials/test/:group", async (c) => {
  requireAdmin(c);
  const env = await withCredentials(c.env.RAW_ENV ?? c.env);
  const group = c.req.param("group");
  try {
    if (group === "shopify") {
      if (!shopifyConfigured(env)) throw new Error("Add the store address and either a Client ID + secret or an Admin API token.");
      const r = await shopify<{ shop: { name: string } }>(env, "{ shop { name } }");
      return c.json({ ok: true, message: `Connected to ${r.shop.name}` });
    }
    if (group === "ups") {
      if (!upsConfigured(env)) throw new Error("Add the Client ID, Client secret and account number.");
      await testUps(env);
      return c.json({ ok: true, message: `UPS accepted the keys (${env.UPS_ENV === "production" ? "live" : "test"} mode)` });
    }
    if (group === "ai") {
      if (!aiConfigured(env)) throw new Error("Add an Anthropic API key.");
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      await client.models.retrieve(env.AI_MODEL || "claude-opus-5-5");
      return c.json({ ok: true, message: `Key works · ${env.AI_MODEL || "claude-opus-5-5"} is available` });
    }
    throw new HttpError(404, "Unknown service");
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw e;
    return c.json({ ok: false, message: (e as Error).message.replace(/^(Shopify|UPS)[^:]*: /, "$1: ") });
  }
});

admin.post("/mailbox/disconnect", async (c) => {
  requireAdmin(c);
  await deleteSetting(c.env, "mailbox");
  await deleteSetting(c.env, "mailbox_access");
  return c.json({ ok: true });
});

export default admin;
