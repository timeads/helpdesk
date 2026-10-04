// Bringing the knowledge base back from the store. The desk manages articles in several store
// blogs (the Knowledge Base blog plus older ones like Tech Support); each article stays in its own
// blog with its own URL. When articles are edited, merged or added on Shopify, the store's version
// replaces the desk's. Everything changed or removed here is saved as an earlier version first.
import type { Env } from "../env";
import { KB_BLOG, cleanHtml, kbBlogId, managedBlogs, slugify, textOf, uniqueId, type KbArticle } from "./kb";
import { saveVersion } from "./kb-merge";
import { shopify } from "./shopify";
import { removeBlog } from "./site-knowledge";
import { nowIso, setSetting } from "./util";

interface StoreArticle { id: string; handle: string; title: string; body: string; tags: string[]; isPublished: boolean; updatedAt: string; description: { value: string } | null }

/** Older blogs' articles go under the matching knowledge-base topic (or one named after the blog). */
const BLOG_TOPICS: Record<string, string> = {
  "getting-started-with-tufting": "Getting Started",
  "all-about-tufting": "Getting Started",
  "compare-the-machines": "Machines & Equipment",
  "high-pile-machines": "Machines & Equipment",
  "all-about-yarn": "Yarn & Fiber",
  "finishing-tufted-pieces": "Adhesive & Finishing",
  "tech-support": "Machine Troubleshooting",
  "workshop-info": "Workshops",
  "tufting-residency": "Workshops",
  "shipping-info": "Orders & Shipping",
  "returns-and-exchanges": "Orders & Shipping",
  "reflect-rewards": "Orders & Shipping",
};

async function blogInfo(env: Env, handle: string): Promise<{ id: string; title: string } | null> {
  if (handle === KB_BLOG) return { id: await kbBlogId(env), title: "Knowledge Base" };
  const d = await shopify<{ blogs: { nodes: { id: string; handle: string; title?: string }[] } }>(env,
    `query KbBlog($q: String!) { blogs(first: 1, query: $q) { nodes { id handle title } } }`, { q: `handle:${handle}` });
  const b = d.blogs.nodes.find((x) => x.handle === handle);
  return b ? { id: b.id, title: b.title ?? handle } : null;
}

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

/** Store HTML → the desk's: our own photos back to /kb/img, links to managed articles back to #id. */
export function fromStoreBody(html: string, pathToId: Map<string, string>) {
  return html
    .replace(/src="https?:\/\/[^"]+?(\/kb\/img\/\d+)"/g, 'src="$1"')
    .replace(/href="(?:https?:\/\/(?:www\.)?tufttheworld\.com)?\/blogs\/([\w-]+)\/([\w-]+)"/g, (m, blog: string, handle: string) => {
      const id = pathToId.get(`${blog}/${handle}`);
      return id ? `href="#${id}"` : m;
    });
}

/**
 * Makes the support desk match the store for every managed blog: store edits replace the desk's
 * text, articles added on the store come in, and ones deleted (or merged away) there are removed
 * here. `blogs` (optional) sets which blogs are managed from now on. Drafts never published are left alone.
 */
export async function pullFromStore(env: Env, agentId: number | null, blogs?: string[]) {
  if (blogs) await setSetting(env, "kb_blogs", [...new Set([KB_BLOG, ...blogs.filter((b) => /^[\w-]+$/.test(b))])]);
  const handles = await managedBlogs(env);
  const fetched: { blog: string; title: string; articles: StoreArticle[] }[] = [];
  for (const handle of handles) {
    const info = await blogInfo(env, handle);
    if (info) fetched.push({ blog: handle, title: info.title, articles: await storeArticles(env, info.id) });
  }
  const pulledBlogs = new Set(fetched.map((f) => f.blog));
  const locals = (await env.DB.prepare("SELECT * FROM kb_articles").all<KbArticle>()).results;
  const byShopify = new Map(locals.filter((a) => a.shopify_id).map((a) => [a.shopify_id!, a]));
  const byPath = new Map(locals.filter((a) => a.shopify_handle).map((a) => [`${a.blog_handle || KB_BLOG}/${a.shopify_handle}`, a]));

  // Topics: a Knowledge Base post's tag; an older blog's post goes under its blog's topic
  const topics = (await env.DB.prepare("SELECT id, name FROM kb_topics").all<{ id: string; name: string }>()).results;
  const topicByName = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
  let topicsAdded = 0;
  const ensureTopic = async (name: string) => {
    const known = topicByName.get(name.toLowerCase());
    if (known) return known;
    const id = slugify(name);
    const pos = await env.DB.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM kb_topics").first<{ p: number }>();
    await env.DB.prepare("INSERT OR IGNORE INTO kb_topics (id, name, icon, position) VALUES (?, ?, '', ?)").bind(id, name.slice(0, 80), pos?.p ?? 0).run();
    topicByName.set(name.toLowerCase(), id);
    topicsAdded++;
    return id;
  };
  const topicFor = async (blog: string, blogTitle: string, tags: string[]) => {
    if (blog === KB_BLOG) return ensureTopic(tags.find((t) => t.toLowerCase() !== "knowledge base") ?? "General");
    const tagged = tags.find((t) => topicByName.has(t.toLowerCase()));
    return ensureTopic(tagged ?? BLOG_TOPICS[blog] ?? blogTitle);
  };

  // Which desk article each store article is (by Shopify id, then by its address)
  const all = fetched.flatMap((f) => f.articles.map((s) => ({ ...s, blog: f.blog, blogTitle: f.title })));
  const matched = new Map(all.map((s) => [s.id, byShopify.get(s.id) ?? byPath.get(`${s.blog}/${s.handle}`)]));
  const pathToId = new Map<string, string>();
  const newIds = new Map<string, string>();
  const taken = new Set(locals.map((a) => a.id));
  for (const s of all) {
    const local = matched.get(s.id);
    let id = local?.id;
    if (!id) {
      id = await uniqueId(env, slugify(s.handle));
      for (let i = 2; taken.has(id); i++) id = `${slugify(s.handle)}-${i}`;
      newIds.set(s.id, id);
    }
    taken.add(id);
    pathToId.set(`${s.blog}/${s.handle}`, id);
  }

  let updated = 0, added = 0, unchanged = 0;
  const now = nowIso();
  for (const s of all) {
    const local = matched.get(s.id);
    const body = cleanHtml(fromStoreBody(s.body ?? "", pathToId));
    const topicId = await topicFor(s.blog, s.blogTitle, s.tags);
    const status = s.isPublished ? "published" : "draft";
    const description = (s.description?.value ?? "").slice(0, 300);
    const tags = s.blog === KB_BLOG ? null : JSON.stringify(s.tags);
    if (local) {
      const same = local.title === s.title && local.body_html === body && local.topic_id === topicId && local.status === status && (local.description ?? "") === description;
      if (!same) {
        await saveVersion(env, local, "Before updating from the store", agentId);
        updated++;
      } else unchanged++;
      await env.DB.prepare(
        `UPDATE kb_articles SET title = ?, body_html = ?, body_text = ?, topic_id = ?, status = ?, description = ?, shopify_id = ?, shopify_handle = ?,
           blog_handle = ?, store_tags = ?, updated_at = ?, synced_at = ?${same ? "" : ", edited_by = ?"} WHERE id = ?`,
      ).bind(s.title, body, textOf(body), topicId, status, description, s.id, s.handle, s.blog, tags, now, now, ...(same ? [] : [agentId]), local.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO kb_articles (id, topic_id, title, body_html, body_text, status, description, shopify_id, shopify_handle, blog_handle, store_tags, synced_at, updated_at, position, edited_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 999, ?)`,
      ).bind(newIds.get(s.id), topicId, s.title, body, textOf(body), status, description, s.id, s.handle, s.blog, tags, now, now, agentId).run();
      added++;
    }
  }

  // On the store before (in a blog read just now) but gone from it now: remove here too
  const onStore = new Set(all.map((s) => s.id));
  const keptLocal = new Set([...matched.values()].filter(Boolean).map((a) => a!.id));
  let removed = 0;
  for (const a of locals) {
    if (!a.shopify_id || onStore.has(a.shopify_id) || keptLocal.has(a.id) || !pulledBlogs.has(a.blog_handle || KB_BLOG)) continue;
    await saveVersion(env, a, "Removed: no longer on the store", agentId);
    await env.DB.batch([
      env.DB.prepare("UPDATE kb_suggestions SET article_id = NULL WHERE article_id = ?").bind(a.id),
      env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(a.id),
    ]);
    removed++;
  }

  // Blogs managed here no longer need a read-only copy in AI knowledge
  for (const blog of pulledBlogs) if (blog !== KB_BLOG) await removeBlog(env, blog);
  const perBlog = Object.fromEntries(fetched.map((f) => [f.blog, f.articles.length]));
  return { updated, added, removed, unchanged, topicsAdded, onStore: all.length, blogs: perBlog };
}
