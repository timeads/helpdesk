// Knowledge base API: articles and topics, importing the old HTML knowledge base, AI suggestions
// from support conversations, and publishing to the store's Knowledge Base blog.
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAdmin } from "../lib/auth";
import { aiConfigured } from "../lib/ai";
import {
  acceptSuggestion, cleanHtml, descriptionFor, importKb, kbArticles, kbPending, kbScanBatch, kbTopics, kbUnsynced, publishBatch, slugify,
  textOf, uniqueId, articleUrl, type ImportInput,
} from "../lib/kb";
import { shopify } from "../lib/shopify";
import { HttpError } from "../lib/util";

const kb = new Hono<AppEnv>();
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

kb.get("/", async (c) => {
  const [topics, articles, pending, scan, unsynced] = await Promise.all([
    kbTopics(c.env),
    kbArticles(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'").first<{ n: number }>(),
    kbPending(c.env),
    kbUnsynced(c.env),
  ]);
  return c.json({
    topics,
    articles: articles.map(({ body_html: _h, body_text, ...a }) => ({ ...a, words: body_text.split(/\s+/).filter(Boolean).length, url: a.shopify_handle && a.synced_at ? articleUrl(a.shopify_handle) : null })),
    suggestions: pending?.n ?? 0,
    toScan: scan,
    unsynced,
    ai: aiConfigured(c.env),
  });
});

kb.get("/article/:id", async (c) => {
  const a = await c.env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(c.req.param("id")).first<any>();
  if (!a) throw new HttpError(404, "Article not found");
  return c.json({ article: { ...a, autoDescription: descriptionFor({ body_text: a.body_text }), url: a.shopify_handle && a.synced_at ? articleUrl(a.shopify_handle) : null } });
});

kb.post("/article", async (c) => {
  const b = await c.req.json<{ title?: string; topic_id?: string }>();
  const title = String(b.title ?? "").trim();
  if (!title) throw new HttpError(400, "Give the article a title");
  const topic = await c.env.DB.prepare("SELECT id FROM kb_topics WHERE id = ?").bind(b.topic_id ?? "").first<{ id: string }>();
  if (!topic) throw new HttpError(400, "Pick a topic");
  const id = await uniqueId(c.env, slugify(title));
  await c.env.DB.prepare("INSERT INTO kb_articles (id, topic_id, title, status, position, edited_by) VALUES (?, ?, ?, 'draft', 999, ?)")
    .bind(id, topic.id, title.slice(0, 200), c.get("agent").id).run();
  return c.json({ id });
});

kb.put("/article/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ title?: string; topic_id?: string; body_html?: string; status?: string; use_in_ai?: boolean; description?: string }>();
  const a = await c.env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(id).first<any>();
  if (!a) throw new HttpError(404, "Article not found");
  const html = b.body_html !== undefined ? cleanHtml(b.body_html) : a.body_html;
  await c.env.DB.prepare(
    `UPDATE kb_articles SET title = ?, topic_id = ?, body_html = ?, body_text = ?, status = ?, use_in_ai = ?, description = ?, edited_by = ?, updated_at = ${now} WHERE id = ?`,
  ).bind(
    String(b.title ?? a.title).trim().slice(0, 200) || a.title,
    b.topic_id ?? a.topic_id,
    html,
    textOf(html),
    b.status === "draft" || b.status === "published" ? b.status : a.status,
    b.use_in_ai === undefined ? a.use_in_ai : b.use_in_ai ? 1 : 0,
    b.description === undefined ? a.description : String(b.description).trim().slice(0, 300),
    c.get("agent").id,
    id,
  ).run();
  return c.json({ ok: true, unsynced: await kbUnsynced(c.env) });
});

kb.delete("/article/:id", async (c) => {
  requireAdmin(c);
  const a = await c.env.DB.prepare("SELECT shopify_id FROM kb_articles WHERE id = ?").bind(c.req.param("id")).first<{ shopify_id: string | null }>();
  if (!a) throw new HttpError(404, "Article not found");
  if (a.shopify_id) {
    const r = await shopify<{ articleDelete: { userErrors: { message: string }[] } }>(c.env,
      `mutation KbArticleDelete($id: ID!) { articleDelete(id: $id) { deletedArticleId userErrors { field message } } }`, { id: a.shopify_id });
    const err = r.articleDelete.userErrors.map((e) => e.message).join("; ");
    if (err && !/not exist|not found/i.test(err)) throw new HttpError(422, `Shopify: ${err}`);
  }
  await c.env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

kb.post("/topic", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<{ name?: string; icon?: string }>();
  const name = String(b.name ?? "").trim();
  if (!name) throw new HttpError(400, "Name the topic");
  const id = slugify(name);
  const pos = await c.env.DB.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM kb_topics").first<{ p: number }>();
  await c.env.DB.prepare("INSERT OR IGNORE INTO kb_topics (id, name, icon, position) VALUES (?, ?, ?, ?)").bind(id, name.slice(0, 80), String(b.icon ?? "").slice(0, 8), pos?.p ?? 0).run();
  return c.json({ id });
});

kb.put("/topic/:id", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<{ name?: string; icon?: string }>();
  await c.env.DB.prepare("UPDATE kb_topics SET name = COALESCE(?, name), icon = COALESCE(?, icon) WHERE id = ?")
    .bind(b.name?.trim().slice(0, 80) || null, b.icon === undefined ? null : String(b.icon).slice(0, 8), c.req.param("id")).run();
  // Articles in it carry the topic as a tag on the store
  await c.env.DB.prepare(`UPDATE kb_articles SET updated_at = ${now} WHERE topic_id = ? AND shopify_id IS NOT NULL`).bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** A photo for an article (resized in the browser). */
kb.post("/image", async (c) => {
  const b = await c.req.json<{ mime?: string; data?: string }>();
  if (!/^image\/(jpeg|png|gif|webp)$/.test(b.mime ?? "")) throw new HttpError(415, "Only photos can be added");
  const data = String(b.data ?? "");
  if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length > 2_500_000) throw new HttpError(413, "That photo is too large");
  const r = await c.env.DB.prepare("INSERT INTO kb_images (mime, data) VALUES (?, ?) RETURNING id").bind(b.mime, data).first<{ id: number }>();
  return c.json({ url: `/kb/img/${r!.id}` });
});

kb.post("/import", async (c) => {
  requireAdmin(c);
  return c.json(await importKb(c.env, await c.req.json<ImportInput>(), c.get("agent").id));
});

// ---- Suggestions from support conversations
kb.get("/suggestions", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, a.title AS article_title FROM kb_suggestions s LEFT JOIN kb_articles a ON a.id = s.article_id
     WHERE s.status = 'pending' ORDER BY s.created_at DESC LIMIT 100`,
  ).all<any>();
  return c.json({ suggestions: results.map((s) => ({ ...s, ticket_ids: JSON.parse(s.ticket_ids || "[]") })) });
});

kb.post("/suggestions/:id{[0-9]+}/accept", async (c) => {
  const b = await c.req.json<{ title?: string; content_html?: string; article_id?: string | null }>().catch(() => ({}));
  return c.json(await acceptSuggestion(c.env, Number(c.req.param("id")), b, c.get("agent").id));
});

/**
 * Accept every waiting suggestion (oldest first, a batch per call; the page repeats until none are
 * left). `edits` carries changes made on the page to particular suggestions.
 */
kb.post("/suggestions/accept-all", async (c) => {
  requireAdmin(c);
  const b = await c.req.json<{ edits?: Record<string, { title?: string; content_html?: string; article_id?: string | null }> }>().catch(() => ({}) as { edits?: undefined });
  const { results } = await c.env.DB.prepare("SELECT id FROM kb_suggestions WHERE status = 'pending' ORDER BY created_at, id LIMIT 30").all<{ id: number }>();
  let accepted = 0;
  const failed: string[] = [];
  for (const { id } of results) {
    try {
      await acceptSuggestion(c.env, id, b.edits?.[id] ?? {}, c.get("agent").id);
      accepted++;
    } catch (e) {
      // e.g. its article was deleted: set it aside so the rest go through
      await c.env.DB.prepare("UPDATE kb_suggestions SET status = 'dismissed' WHERE id = ?").bind(id).run();
      failed.push((e as Error).message);
    }
  }
  const left = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'").first<{ n: number }>();
  return c.json({ accepted, failed, remaining: left?.n ?? 0 });
});

kb.post("/suggestions/dismiss-all", async (c) => {
  requireAdmin(c);
  const r = await c.env.DB.prepare("UPDATE kb_suggestions SET status = 'dismissed' WHERE status = 'pending'").run();
  return c.json({ dismissed: r.meta.changes ?? 0 });
});

kb.post("/suggestions/:id{[0-9]+}/dismiss", async (c) => {
  await c.env.DB.prepare("UPDATE kb_suggestions SET status = 'dismissed' WHERE id = ?").bind(Number(c.req.param("id"))).run();
  return c.json({ ok: true });
});

kb.post("/scan", async (c) => {
  requireAdmin(c);
  const { size } = await c.req.json<{ size?: number }>().catch(() => ({ size: undefined }));
  return c.json(await kbScanBatch(c.env, size ?? 6));
});

/** Publishes changed articles to the store (a few per call; the page repeats). */
kb.post("/publish", async (c) => {
  requireAdmin(c);
  return c.json(await publishBatch(c.env, new URL(c.req.url).origin));
});

export default kb;
