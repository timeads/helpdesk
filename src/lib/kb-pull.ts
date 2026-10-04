// Bringing the knowledge base back from the store: when articles were edited, merged or added on
// Shopify (the Knowledge Base blog), the store's version replaces the support desk's. Everything it
// changes or removes here is saved as an earlier version first.
import type { Env } from "../env";
import { cleanHtml, kbBlogId, slugify, textOf, uniqueId, type KbArticle } from "./kb";
import { saveVersion } from "./kb-merge";
import { shopify } from "./shopify";
import { nowIso } from "./util";

interface StoreArticle { id: string; handle: string; title: string; body: string; tags: string[]; isPublished: boolean; updatedAt: string; description: { value: string } | null }

async function storeArticles(env: Env, blogId: string): Promise<StoreArticle[]> {
  const out: StoreArticle[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { blog: { articles: { nodes: StoreArticle[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } = await shopify(env,
      `query KbPull($id: ID!, $after: String) { blog(id: $id) { articles(first: 50, after: $after) { nodes { id handle title body summary tags isPublished updatedAt description: metafield(namespace: "global", key: "description_tag") { value } } pageInfo { hasNextPage endCursor } } } }`,
      { id: blogId, after });
    if (!d.blog) break;
    out.push(...d.blog.articles.nodes);
    if (!d.blog.articles.pageInfo.hasNextPage) break;
    after = d.blog.articles.pageInfo.endCursor;
  }
  return out;
}

/** Store HTML → the desk's: our own photos back to /kb/img, links between articles back to #id. */
export function fromStoreBody(html: string, handleToId: Map<string, string>) {
  return html
    .replace(/src="https?:\/\/[^"]+?(\/kb\/img\/\d+)"/g, 'src="$1"')
    .replace(/href="(?:https?:\/\/(?:www\.)?tufttheworld\.com)?\/blogs\/knowledge-base\/([\w-]+)"/g, (m, handle: string) => (handleToId.has(handle) ? `href="#${handleToId.get(handle)}"` : m));
}

/**
 * Makes the support desk match the store's Knowledge Base blog: store edits replace the desk's text,
 * articles added on the store come in, and ones deleted (or merged away) there are removed here.
 * Drafts that were never published to the store are left alone.
 */
export async function pullFromStore(env: Env, agentId: number | null) {
  const blogId = await kbBlogId(env);
  const store = await storeArticles(env, blogId);
  const locals = (await env.DB.prepare("SELECT * FROM kb_articles").all<KbArticle>()).results;
  const byShopify = new Map(locals.filter((a) => a.shopify_id).map((a) => [a.shopify_id!, a]));
  const byHandle = new Map(locals.filter((a) => a.shopify_handle).map((a) => [a.shopify_handle!, a]));

  // Topics come from the article's tag (other than "Knowledge Base"); new tags become topics
  const topics = (await env.DB.prepare("SELECT id, name FROM kb_topics").all<{ id: string; name: string }>()).results;
  const topicByName = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
  let topicsAdded = 0;
  const topicFor = async (tags: string[]) => {
    const name = tags.find((t) => t.toLowerCase() !== "knowledge base") ?? "General";
    const known = topicByName.get(name.toLowerCase());
    if (known) return known;
    const id = slugify(name);
    const pos = await env.DB.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM kb_topics").first<{ p: number }>();
    await env.DB.prepare("INSERT OR IGNORE INTO kb_topics (id, name, icon, position) VALUES (?, ?, '', ?)").bind(id, name.slice(0, 80), pos?.p ?? 0).run();
    topicByName.set(name.toLowerCase(), id);
    topicsAdded++;
    return id;
  };

  // Which desk article each store article is (matching by Shopify id, then by its address)
  const matched = new Map<string, KbArticle | undefined>(store.map((s) => [s.id, byShopify.get(s.id) ?? byHandle.get(s.handle)]));
  const handleToId = new Map<string, string>();
  const newIds = new Map<string, string>();
  for (const s of store) {
    const local = matched.get(s.id);
    const id = local?.id ?? (await uniqueId(env, slugify(s.handle)));
    if (!local) newIds.set(s.id, id);
    handleToId.set(s.handle, id);
  }

  let updated = 0, added = 0, unchanged = 0;
  const now = nowIso();
  for (const s of store) {
    const local = matched.get(s.id);
    const body = cleanHtml(fromStoreBody(s.body ?? "", handleToId));
    const topicId = await topicFor(s.tags);
    const status = s.isPublished ? "published" : "draft";
    const description = (s.description?.value ?? "").slice(0, 300);
    if (local) {
      const same = local.title === s.title && local.body_html === body && local.topic_id === topicId && local.status === status && (local.description ?? "") === description;
      if (!same) {
        await saveVersion(env, local, "Before updating from the store", agentId);
        updated++;
      } else unchanged++;
      await env.DB.prepare(
        `UPDATE kb_articles SET title = ?, body_html = ?, body_text = ?, topic_id = ?, status = ?, description = ?, shopify_id = ?, shopify_handle = ?,
           updated_at = ?, synced_at = ?${same ? "" : ", edited_by = ?"} WHERE id = ?`,
      ).bind(s.title, body, textOf(body), topicId, status, description, s.id, s.handle, now, now, ...(same ? [] : [agentId]), local.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO kb_articles (id, topic_id, title, body_html, body_text, status, description, shopify_id, shopify_handle, synced_at, updated_at, position, edited_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 999, ?)`,
      ).bind(newIds.get(s.id), topicId, s.title, body, textOf(body), status, description, s.id, s.handle, now, now, agentId).run();
      added++;
    }
  }

  // Published here before but gone from the store now (deleted or merged there): remove here too
  const onStore = new Set(store.map((s) => s.id));
  const keptLocal = new Set([...matched.values()].filter(Boolean).map((a) => a!.id));
  let removed = 0;
  for (const a of locals) {
    if (!a.shopify_id || onStore.has(a.shopify_id) || keptLocal.has(a.id)) continue;
    await saveVersion(env, a, "Removed: no longer on the store", agentId);
    await env.DB.batch([
      env.DB.prepare("UPDATE kb_suggestions SET article_id = NULL WHERE article_id = ?").bind(a.id),
      env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(a.id),
    ]);
    removed++;
  }
  return { updated, added, removed, unchanged, topicsAdded, onStore: store.length };
}
