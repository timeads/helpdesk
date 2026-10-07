// Repair manual API: topics, their cases and media, and the AI pass over repair conversations.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { HttpError } from "../lib/util";
import { aiConfigured } from "../lib/ai";
import { NEW_DAYS, pendingCount, scanBatch, scanTicket } from "../lib/manual";
import { copyTopicFor } from "../lib/manual-copy";

const manual = new Hono<AppEnv>();

manual.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.title, t.product, t.summary, t.status, t.use_in_ai, t.updated_at, t.created_at,
            (SELECT COUNT(*) FROM manual_cases x WHERE x.topic_id = t.id) AS cases,
            (SELECT MAX(happened_at) FROM manual_cases x WHERE x.topic_id = t.id) AS last_case,
            (SELECT COUNT(*) FROM manual_media m WHERE m.topic_id = t.id) AS media
     FROM manual_topics t ORDER BY t.product COLLATE NOCASE, cases DESC, t.title COLLATE NOCASE`,
  ).all();
  const scanned = await c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(result = 'repair') AS repairs FROM manual_scanned").first<{ n: number; repairs: number | null }>();
  const [pendingNew, pendingArchive] = await Promise.all([pendingCount(c.env, "new"), pendingCount(c.env, "archive")]);
  return c.json({ topics: results, pending: pendingNew + pendingArchive, pendingNew, pendingArchive, newDays: NEW_DAYS, scanned: scanned?.n ?? 0, repairs: scanned?.repairs ?? 0, ai: aiConfigured(c.env) });
});

manual.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const topic = await c.env.DB.prepare(
    "SELECT t.*, f.title AS copied_from_title, f.product AS copied_from_product FROM manual_topics t LEFT JOIN manual_topics f ON f.id = t.copied_from WHERE t.id = ?",
  ).bind(id).first();
  if (!topic) throw new HttpError(404, "Topic not found");
  const [cases, media] = await Promise.all([
    c.env.DB.prepare(
      `SELECT x.ticket_id, x.summary, x.outcome, x.happened_at, t.subject, t.customer_name, t.customer_email
       FROM manual_cases x JOIN tickets t ON t.id = x.ticket_id WHERE x.topic_id = ? ORDER BY x.happened_at DESC`,
    ).bind(id).all(),
    c.env.DB.prepare("SELECT id, ticket_id, message_id, attachment_id, filename, mime, caption FROM manual_media WHERE topic_id = ? ORDER BY id").bind(id).all(),
  ]);
  return c.json({ topic, cases: cases.results, media: media.results });
});

manual.post("/", async (c) => {
  const b = await c.req.json<{ title?: string; product?: string }>();
  if (!b.title?.trim()) throw new HttpError(400, "Give the topic a title");
  const r = await c.env.DB.prepare("INSERT INTO manual_topics (title, product, edited_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING id")
    .bind(b.title.trim().slice(0, 160), (b.product ?? "").trim().slice(0, 120)).first<{ id: number }>();
  return c.json({ id: r!.id });
});

manual.put("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await c.req.json<{ title?: string; product?: string; summary?: string; body?: string; status?: string; use_in_ai?: boolean }>();
  const cur = await c.env.DB.prepare("SELECT * FROM manual_topics WHERE id = ?").bind(id).first<any>();
  if (!cur) throw new HttpError(404, "Topic not found");
  const textChanged = ["title", "product", "summary", "body"].some((k) => (b as any)[k] !== undefined && (b as any)[k] !== cur[k]);
  await c.env.DB.prepare(
    `UPDATE manual_topics SET title = ?, product = ?, summary = ?, body = ?, status = ?, use_in_ai = ?,
       edited_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE edited_at END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).bind(
    (b.title ?? cur.title).trim().slice(0, 160) || cur.title,
    (b.product ?? cur.product).trim().slice(0, 120),
    (b.summary ?? cur.summary).slice(0, 500),
    (b.body ?? cur.body).slice(0, 40000),
    b.status === "published" || b.status === "draft" ? b.status : cur.status,
    b.use_in_ai === undefined ? cur.use_in_ai : b.use_in_ai ? 1 : 0,
    textChanged ? 1 : 0,
    id,
  ).run();
  return c.json({ ok: true });
});

manual.delete("/:id{[0-9]+}", async (c) => {
  requireAdmin(c);
  const id = Number(c.req.param("id"));
  // Its conversations can be read again (into another topic) on the next update
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM manual_scanned WHERE ticket_id IN (SELECT ticket_id FROM manual_cases WHERE topic_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM manual_media WHERE topic_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM manual_cases WHERE topic_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM manual_topics WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

/** A draft copy of this topic adapted for another machine (AI), with what to check before publishing. */
manual.post("/:id{[0-9]+}/copy", async (c) => {
  if (!aiConfigured(c.env)) throw new HttpError(409, "AI is off — add an Anthropic API key in Settings → Connections");
  const b = await c.req.json<{ product?: string; notes?: string; withMedia?: boolean }>();
  return c.json(await copyTopicFor(c.env, Number(c.req.param("id")), String(b.product ?? ""), { notes: b.notes, withMedia: !!b.withMedia }));
});

/** Moves every case and photo of one topic into another, then removes the first. */
manual.post("/:id{[0-9]+}/merge", async (c) => {
  const from = Number(c.req.param("id"));
  const { into } = await c.req.json<{ into: number }>();
  if (!into || into === from) throw new HttpError(400, "Pick a different topic to merge into");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO manual_cases (topic_id, ticket_id, summary, outcome, happened_at) SELECT ?, ticket_id, summary, outcome, happened_at FROM manual_cases WHERE topic_id = ?").bind(into, from),
    c.env.DB.prepare("INSERT OR IGNORE INTO manual_media (topic_id, ticket_id, message_id, attachment_id, filename, mime, caption) SELECT ?, ticket_id, message_id, attachment_id, filename, mime, caption FROM manual_media WHERE topic_id = ?").bind(into, from),
    c.env.DB.prepare("DELETE FROM manual_media WHERE topic_id = ?").bind(from),
    c.env.DB.prepare("DELETE FROM manual_cases WHERE topic_id = ?").bind(from),
    c.env.DB.prepare("DELETE FROM manual_topics WHERE id = ?").bind(from),
  ]);
  return c.json({ ok: true });
});

manual.put("/:id{[0-9]+}/media/:mid{[0-9]+}", async (c) => {
  const { caption } = await c.req.json<{ caption?: string }>();
  await c.env.DB.prepare("UPDATE manual_media SET caption = ? WHERE id = ? AND topic_id = ?").bind(String(caption ?? "").slice(0, 300), Number(c.req.param("mid")), Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

manual.delete("/:id{[0-9]+}/media/:mid{[0-9]+}", async (c) => {
  await c.env.DB.prepare("DELETE FROM manual_media WHERE id = ? AND topic_id = ?").bind(Number(c.req.param("mid")), Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

/** Reads the next few repair conversations into the manual (the page calls this repeatedly). */
manual.post("/scan", async (c) => {
  requireAdmin(c);
  const { size, scope } = await c.req.json<{ size?: number; scope?: string }>().catch(() => ({ size: undefined, scope: undefined }));
  return c.json(await scanBatch(c.env, size ?? 4, scope === "new" || scope === "archive" ? scope : "all"));
});

/** Adds one conversation to the manual now (e.g. an email answered today), without a full scan. */
manual.post("/ticket/:id{[0-9]+}", async (c) => {
  requireAdmin(c);
  return c.json(await scanTicket(c.env, Number(c.req.param("id"))));
});

export default manual;
