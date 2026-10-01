import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { DEFAULT_RULES, getMailbox, runBackfill, type BackfillJob, type MailRules } from "../lib/gmail";
import { shopifyConfigured } from "../lib/shopify";
import { upsConfigured } from "../lib/ups";
import { aiConfigured } from "../lib/ai";
import { HttpError, deleteSetting, getSetting, setSetting } from "../lib/util";
import { CREDENTIAL_FIELDS, describeCredentials, saveCredentials, withCredentials } from "../lib/credentials";
import { shopify } from "../lib/shopify";
import { testUps } from "../lib/ups";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_SUPPORT, RULE_ACTIONS, RULE_FIELDS, STATUSES, TRIGGERS, loadSupportRules, supportSettings, type SupportSettings } from "../lib/support";
import { MACRO_VARIABLES } from "../lib/macros";

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
  const { results } = await c.env.DB.prepare("SELECT id, email, name, role, available FROM agents WHERE active = 1 ORDER BY name").all();
  return c.json({ agents: results });
});

/** Availability for automatic assignment (round robin / balanced skip unavailable teammates). */
admin.patch("/agents/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  if (id !== c.get("agent").id) requireAdmin(c);
  const { available } = await c.req.json<{ available: boolean }>();
  await c.env.DB.prepare("UPDATE agents SET available = ? WHERE id = ?").bind(available ? 1 : 0, id).run();
  return c.json({ ok: true });
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
    c.env.DB.prepare("UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ? AND status IN ('open','in_progress','snoozed')").bind(id),
  ]);
  return c.json({ ok: true });
});

const MACRO_ACTION_TYPES = ["add_tags", "set_status", "set_subject", "add_note", "set_priority"];
const cleanActions = (a: unknown) =>
  (Array.isArray(a) ? a : [])
    .filter((x: any) => MACRO_ACTION_TYPES.includes(x?.type) && typeof x.value === "string" && x.value.trim())
    .map((x: any) => ({ type: x.type, value: x.value.trim().slice(0, 2000) }))
    .slice(0, 10);

admin.get("/macros", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, body, actions, uses FROM macros ORDER BY name").all<any>();
  return c.json({
    macros: results.map((m) => ({ ...m, actions: JSON.parse(m.actions || "[]") })),
    variables: MACRO_VARIABLES,
  });
});

admin.post("/macros", async (c) => {
  const { name, body, actions } = await c.req.json<{ name: string; body: string; actions?: unknown }>();
  if (!name?.trim() || !body?.trim()) throw new HttpError(400, "A saved reply needs a name and text");
  await c.env.DB.prepare("INSERT INTO macros (name, body, actions) VALUES (?, ?, ?)").bind(name.trim(), body.trim(), JSON.stringify(cleanActions(actions))).run();
  return c.json({ ok: true });
});

/** Bulk import, e.g. from a Redo macro export: [{name, body, actions?}]. Existing names are updated. */
admin.post("/macros/import", async (c) => {
  requireAdmin(c);
  const { macros } = await c.req.json<{ macros: { name: string; body: string; actions?: unknown }[] }>();
  let added = 0;
  let updated = 0;
  for (const m of (macros ?? []).slice(0, 1000)) {
    if (!m.name?.trim() || !m.body?.trim()) continue;
    const existing = await c.env.DB.prepare("SELECT id FROM macros WHERE name = ? COLLATE NOCASE").bind(m.name.trim()).first<{ id: number }>();
    if (existing) {
      await c.env.DB.prepare("UPDATE macros SET body = ?, actions = ? WHERE id = ?").bind(m.body.trim(), JSON.stringify(cleanActions(m.actions)), existing.id).run();
      updated++;
    } else {
      await c.env.DB.prepare("INSERT INTO macros (name, body, actions) VALUES (?, ?, ?)").bind(m.name.trim(), m.body.trim(), JSON.stringify(cleanActions(m.actions))).run();
      added++;
    }
  }
  return c.json({ ok: true, added, updated });
});

admin.put("/macros/:id{[0-9]+}", async (c) => {
  const { name, body, actions } = await c.req.json<{ name: string; body: string; actions?: unknown }>();
  if (!name?.trim() || !body?.trim()) throw new HttpError(400, "A saved reply needs a name and text");
  await c.env.DB.prepare("UPDATE macros SET name = ?, body = ?, actions = ? WHERE id = ?")
    .bind(name.trim(), body.trim(), JSON.stringify(cleanActions(actions)), Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

admin.delete("/macros/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM macros WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Tags

admin.get("/tags", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.group_name, g.color,
       (SELECT COUNT(*) FROM tickets t, json_each(t.tags) j WHERE j.value = g.name COLLATE NOCASE AND t.status NOT IN ('deleted','spam')) AS uses
     FROM tags g ORDER BY g.group_name, g.name COLLATE NOCASE`,
  ).all();
  return c.json({ tags: results });
});

admin.post("/tags", async (c) => {
  const { name, group_name, color } = await c.req.json<{ name: string; group_name?: string; color?: string }>();
  if (!name?.trim()) throw new HttpError(400, "Name the tag");
  await c.env.DB.prepare(
    "INSERT INTO tags (name, group_name, color) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET group_name = excluded.group_name, color = excluded.color",
  )
    .bind(name.trim(), group_name?.trim() || "General", color || null)
    .run();
  return c.json({ ok: true });
});

/** Rename / regroup a tag; a rename is applied to every ticket that has it. */
admin.put("/tags/:id{[0-9]+}", async (c) => {
  requireAdmin(c);
  const id = Number(c.req.param("id"));
  const { name, group_name, color } = await c.req.json<{ name: string; group_name?: string; color?: string | null }>();
  const old = await c.env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind(id).first<{ name: string }>();
  if (!old) throw new HttpError(404, "Tag not found");
  const next = name?.trim() || old.name;
  await c.env.DB.prepare("UPDATE tags SET name = ?, group_name = ?, color = ? WHERE id = ?").bind(next, group_name?.trim() || "General", color ?? null, id).run();
  if (next !== old.name) await retag(c.env, old.name, next);
  return c.json({ ok: true });
});

admin.delete("/tags/:id{[0-9]+}", async (c) => {
  requireAdmin(c);
  const id = Number(c.req.param("id"));
  const old = await c.env.DB.prepare("SELECT name FROM tags WHERE id = ?").bind(id).first<{ name: string }>();
  if (!old) throw new HttpError(404, "Tag not found");
  await c.env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
  await retag(c.env, old.name, null);
  return c.json({ ok: true });
});

async function retag(env: AppEnv["Bindings"], from: string, to: string | null) {
  const { results } = await env.DB.prepare(
    "SELECT t.id, t.tags FROM tickets t WHERE EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = ? COLLATE NOCASE)",
  )
    .bind(from)
    .all<{ id: number; tags: string }>();
  const stmts = results.map((r) => {
    const tags = (JSON.parse(r.tags) as string[]).flatMap((x) => (x.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [x]));
    return env.DB.prepare("UPDATE tickets SET tags = ? WHERE id = ?").bind(JSON.stringify([...new Set(tags)]), r.id);
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

// ---------------------------------------------------------------- Saved views

admin.get("/views", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, folder, filters, position FROM views ORDER BY COALESCE(folder, ''), position, id").all<any>();
  return c.json({ views: results.map((v) => ({ ...v, filters: JSON.parse(v.filters || "{}") })) });
});

const cleanFilters = (f: any) => ({
  ...(f?.status ? { status: String(f.status) } : {}),
  ...(Array.isArray(f?.tags_any) && f.tags_any.length ? { tags_any: f.tags_any.map(String).slice(0, 20) } : {}),
  ...(f?.assignee ? { assignee: String(f.assignee) } : {}),
  ...(f?.priority ? { priority: String(f.priority) } : {}),
  ...(f?.unread ? { unread: true } : {}),
  ...(f?.q ? { q: String(f.q).slice(0, 200) } : {}),
});

admin.post("/views", async (c) => {
  const { name, folder, filters } = await c.req.json<{ name: string; folder?: string; filters: unknown }>();
  if (!name?.trim()) throw new HttpError(400, "Name the view");
  const r = await c.env.DB.prepare("INSERT INTO views (name, folder, filters, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM views)) RETURNING id")
    .bind(name.trim(), folder?.trim() || null, JSON.stringify(cleanFilters(filters)))
    .first<{ id: number }>();
  return c.json({ ok: true, id: r!.id });
});

admin.put("/views/:id{[0-9]+}", async (c) => {
  const { name, folder, filters, position } = await c.req.json<{ name: string; folder?: string; filters: unknown; position?: number }>();
  if (!name?.trim()) throw new HttpError(400, "Name the view");
  await c.env.DB.prepare("UPDATE views SET name = ?, folder = ?, filters = ?, position = COALESCE(?, position) WHERE id = ?")
    .bind(name.trim(), folder?.trim() || null, JSON.stringify(cleanFilters(filters)), position ?? null, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

admin.delete("/views/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM views WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Support rules

admin.get("/support-rules", async (c) => {
  return c.json({
    rules: await loadSupportRules(c.env),
    triggers: TRIGGERS,
    fields: RULE_FIELDS,
    actions: RULE_ACTIONS,
    statuses: STATUSES,
  });
});

/** Replaces all rules (the editor saves the whole list; order = position). */
admin.put("/support-rules", async (c) => {
  requireAdmin(c);
  const { rules } = await c.req.json<{ rules: any[] }>();
  const stmts = [c.env.DB.prepare("DELETE FROM support_rules")];
  (rules ?? []).slice(0, 200).forEach((r, i) => {
    if (!r?.name?.trim() || !(r.trigger in TRIGGERS)) throw new HttpError(400, "Every rule needs a name and a trigger");
    const conditions = (Array.isArray(r.conditions) ? r.conditions : []).filter((x: any) => x?.field in RULE_FIELDS).map((x: any) => ({ field: x.field, op: x.op, value: String(x.value ?? "") }));
    const actions = (Array.isArray(r.actions) ? r.actions : []).filter((x: any) => RULE_ACTIONS.includes(x?.type)).map((x: any) => ({ type: x.type, value: String(x.value ?? "") }));
    stmts.push(
      c.env.DB.prepare("INSERT INTO support_rules (name, trigger, enabled, position, match, conditions, actions) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        r.name.trim(),
        r.trigger,
        r.enabled ? 1 : 0,
        i,
        r.match === "any" ? "any" : "all",
        JSON.stringify(conditions),
        JSON.stringify(actions),
      ),
    );
  });
  await c.env.DB.batch(stmts);
  return c.json({ rules: await loadSupportRules(c.env) });
});

// ---------------------------------------------------------------- Knowledge (used by AI drafts)

admin.get("/knowledge", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, content, type, status, uses, created_at FROM knowledge ORDER BY created_at DESC").all();
  return c.json({ knowledge: results });
});

const KNOWLEDGE_TYPES = ["policy", "faq", "product", "shipping", "other"];

admin.post("/knowledge", async (c) => {
  const b = await c.req.json<{ name: string; content: string; type?: string; status?: string }>();
  if (!b.name?.trim() || !b.content?.trim()) throw new HttpError(400, "Add a title and the content");
  await c.env.DB.prepare("INSERT INTO knowledge (name, content, type, status) VALUES (?, ?, ?, ?)")
    .bind(b.name.trim(), b.content.trim(), KNOWLEDGE_TYPES.includes(b.type ?? "") ? b.type : "policy", b.status === "inactive" ? "inactive" : "active")
    .run();
  return c.json({ ok: true });
});

/** Bulk import (e.g. Redo AI Knowledge CSV parsed in the browser): [{name, content, type?}]. */
admin.post("/knowledge/import", async (c) => {
  requireAdmin(c);
  const { entries } = await c.req.json<{ entries: { name: string; content: string; type?: string; status?: string }[] }>();
  const stmts = (entries ?? [])
    .filter((e) => e.name?.trim() && e.content?.trim())
    .slice(0, 1000)
    .map((e) =>
      c.env.DB.prepare("INSERT INTO knowledge (name, content, type, status) VALUES (?, ?, ?, ?)").bind(
        e.name.trim(),
        e.content.trim(),
        KNOWLEDGE_TYPES.includes((e.type ?? "").toLowerCase()) ? e.type!.toLowerCase() : "other",
        e.status?.toLowerCase() === "inactive" ? "inactive" : "active",
      ),
    );
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return c.json({ ok: true, added: stmts.length });
});

admin.put("/knowledge/:id{[0-9]+}", async (c) => {
  const b = await c.req.json<{ name: string; content: string; type?: string; status?: string }>();
  if (!b.name?.trim() || !b.content?.trim()) throw new HttpError(400, "Add a title and the content");
  await c.env.DB.prepare("UPDATE knowledge SET name = ?, content = ?, type = ?, status = ? WHERE id = ?")
    .bind(b.name.trim(), b.content.trim(), KNOWLEDGE_TYPES.includes(b.type ?? "") ? b.type : "policy", b.status === "inactive" ? "inactive" : "active", Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

admin.delete("/knowledge/:id{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM knowledge WHERE id = ?").bind(Number(c.req.param("id"))).run();
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
    support: await supportSettings(c.env),
    backfill: await getSetting<BackfillJob | null>(c.env, "backfill", null),
  });
});

admin.put("/settings", async (c) => {
  requireAdmin(c);
  const body = await c.req.json<{ signature?: string; mailRules?: Partial<MailRules>; shipFrom?: unknown; aiGuidance?: string; support?: Partial<SupportSettings> }>();
  if (body.support) {
    const cur = await supportSettings(c.env);
    const s = { ...cur, ...body.support };
    await setSetting(c.env, "support", {
      assignment: ["manual", "round_robin", "balanced"].includes(s.assignment) ? s.assignment : DEFAULT_SUPPORT.assignment,
      autoMerge: !!s.autoMerge,
      mergeExclusions: (s.mergeExclusions ?? []).map((x) => String(x).trim()).filter(Boolean),
      closeOnGmailArchive: !!s.closeOnGmailArchive,
      afterClose: ["next", "list", "stay"].includes(s.afterClose) ? s.afterClose : "next",
      undoSendSeconds: Math.min(30, Math.max(0, Number(s.undoSendSeconds) || 0)),
      aiAutoInsights: !!s.aiAutoInsights,
    } satisfies SupportSettings);
  }
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

/** Start importing older email (runs in the background, a batch every minute). */
admin.post("/mailbox/backfill", async (c) => {
  requireAdmin(c);
  const { days } = await c.req.json<{ days: number }>();
  const d = Math.min(3650, Math.max(1, Math.round(Number(days) || 365)));
  if (!(await getMailbox(c.env))) throw new HttpError(409, "Connect Gmail first");
  await setSetting(c.env, "backfill", { days: d, pageToken: null, threads: 0, created: 0, startedAt: new Date().toISOString() } satisfies BackfillJob);
  return c.json({ job: await runBackfill(c.env, 10) });
});

admin.post("/mailbox/backfill/stop", async (c) => {
  requireAdmin(c);
  const job = await getSetting<BackfillJob | null>(c.env, "backfill", null);
  if (job && !job.finishedAt) await setSetting(c.env, "backfill", { ...job, finishedAt: new Date().toISOString(), error: "Stopped" });
  return c.json({ ok: true });
});

admin.post("/mailbox/disconnect", async (c) => {
  requireAdmin(c);
  await deleteSetting(c.env, "mailbox");
  await deleteSetting(c.env, "mailbox_access");
  return c.json({ ok: true });
});

export default admin;
