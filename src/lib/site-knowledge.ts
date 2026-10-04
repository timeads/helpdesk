// AI knowledge from the store website: Shopify pages and policies (refunds, shipping, terms…) or any
// public page by link. Each becomes an AI knowledge entry that refreshes itself daily, so the
// chat and AI replies follow whatever the site says.
import type { Env } from "../env";
import { shopify } from "./shopify";
import { htmlToText } from "./mime";
import { HttpError, getSetting, nowIso, setSetting } from "./util";

const STORE = "https://tufttheworld.com";
const MAX = 20000;

interface Policy { id: string; type: string; title: string; body: string; url: string; updatedAt: string }
interface Page { id: string; title: string; handle: string; isPublished?: boolean; updatedAt: string; bodySummary?: string; body?: string }

const clean = (html: string) => htmlToText(html).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX);
const pageType = (title: string) => (/ship|deliver/i.test(title) ? "shipping" : /faq|question/i.test(title) ? "faq" : /polic|return|refund|warrant|term|privacy|exchange/i.test(title) ? "policy" : "other");

/** Everything on the store that could be added, and which ones already are. */
export async function siteSources(env: Env) {
  const d = await shopify<{ shop: { shopPolicies: Policy[] }; pages: { nodes: Page[] }; blogs: { nodes: { id: string; title: string; handle: string; articlesCount: { count: number } }[] } }>(
    env,
    `query SiteSources { shop { shopPolicies { id type title body url updatedAt } } pages(first: 100, sortKey: TITLE) { nodes { id title handle isPublished updatedAt bodySummary } } blogs(first: 50) { nodes { id title handle articlesCount { count } } } }`,
  );
  const { results } = await env.DB.prepare("SELECT source FROM knowledge WHERE source IS NOT NULL").all<{ source: string }>();
  const added = new Set(results.map((r) => (r.source.startsWith("blog:") ? r.source.split(":").slice(0, 2).join(":") : r.source)));
  return {
    policies: d.shop.shopPolicies.filter((p) => p.body?.trim()).map((p) => ({ source: `policy:${p.type}`, title: p.title, url: p.url, added: added.has(`policy:${p.type}`) })),
    pages: d.pages.nodes.filter((p) => p.isPublished !== false).map((p) => ({
      source: `page:${p.id}`, title: p.title, url: `${STORE}/pages/${p.handle}`, summary: (p.bodySummary ?? "").slice(0, 140), added: added.has(`page:${p.id}`),
    })),
    // The knowledge base's own blog is edited in Repair manual → Knowledge base, so it isn't offered here
    blogs: (d.blogs?.nodes ?? []).filter((b) => b.handle !== "knowledge-base" && b.articlesCount.count > 0).map((b) => ({
      source: `blog:${b.handle}`, title: b.title, url: `${STORE}/blogs/${b.handle}`, count: b.articlesCount.count, added: added.has(`blog:${b.handle}`),
    })),
  };
}

async function upsert(env: Env, source: string, title: string, content: string, url: string, type: string) {
  if (!content) return false;
  await env.DB.prepare(
    `INSERT INTO knowledge (name, content, type, status, source, source_url, synced_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(source) WHERE source IS NOT NULL DO UPDATE SET name = excluded.name, content = excluded.content, source_url = excluded.source_url, synced_at = excluded.synced_at`,
  ).bind(title.slice(0, 200), content, type, source, url, nowIso()).run();
  return true;
}

/** Reads a public web page as text (the main content, without menus and footers). */
export async function readUrl(url: string): Promise<{ title: string; text: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw new HttpError(400, "Use a public http(s) link");
  const res = await fetch(u.toString(), { headers: { "user-agent": "TuftTheWorldSupport/1.0 (+knowledge sync)", accept: "text/html,text/plain" }, redirect: "follow" });
  if (!res.ok) throw new HttpError(422, `That page answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/(html|plain)/.test(type)) throw new HttpError(415, "That link isn't a web page");
  const html = (await res.text()).slice(0, 3_000_000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? u.pathname).replace(/\s+/g, " ").trim();
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? html;
  const text = clean(main.replace(/<(nav|header|footer|aside|form|noscript|svg)\b[\s\S]*?<\/\1>/gi, ""));
  if (text.length < 40) throw new HttpError(422, "Couldn't find any text on that page");
  return { title: title.replace(/\s*[–|-]\s*Tuft the World.*$/i, "") || u.hostname, text };
}

/** Adds (or refreshes) the chosen sources. */
export async function addSources(env: Env, sources: string[]) {
  let added = 0;
  const policies = sources.filter((s) => s.startsWith("policy:"));
  const pages = sources.filter((s) => s.startsWith("page:"));
  const urls = sources.filter((s) => s.startsWith("url:"));
  const blogs = [...new Set(sources.filter((s) => s.startsWith("blog:")).map((s) => s.split(":")[1]))];
  for (const handle of blogs.slice(0, 20)) added += await addBlog(env, handle);
  if (policies.length) {
    const d = await shopify<{ shop: { shopPolicies: Policy[] } }>(env, `query SitePolicies { shop { primaryDomain { url } shopPolicies { id type title body url updatedAt } } }`);
    for (const p of d.shop.shopPolicies) {
      if (policies.includes(`policy:${p.type}`) && (await upsert(env, `policy:${p.type}`, p.title, clean(p.body), p.url, /SHIPPING/.test(p.type) ? "shipping" : "policy"))) added++;
    }
  }
  for (let i = 0; i < pages.length; i += 25) {
    const ids = pages.slice(i, i + 25).map((s) => s.slice(5));
    const d = await shopify<{ nodes: (Page | null)[] }>(env, `query SitePages($ids: [ID!]!) { nodes(ids: $ids) { ... on Page { id title handle body updatedAt } } }`, { ids });
    for (const p of d.nodes) {
      if (p?.id && (await upsert(env, `page:${p.id}`, p.title, clean(p.body ?? ""), `${STORE}/pages/${p.handle}`, pageType(p.title)))) added++;
    }
  }
  for (const s of urls.slice(0, 10)) {
    const url = s.slice(4);
    const r = await readUrl(url);
    if (await upsert(env, `url:${url}`, r.title, r.text, url, pageType(r.title))) added++;
  }
  return { added };
}

/**
 * Every published article in one of the store's blogs, as its own AI knowledge entry (type
 * "article": looked up when relevant rather than sent every time). Articles gone from the blog go.
 */
async function addBlog(env: Env, handle: string): Promise<number> {
  const seen = new Set<string>();
  let n = 0;
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { blogs: { nodes: { handle: string; articles: { nodes: { id: string; handle: string; title: string; body: string; isPublished: boolean }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } }[] } } = await shopify(env,
      `query SiteBlogArticles($q: String!, $after: String) { blogs(first: 1, query: $q) { nodes { id handle title articles(first: 50, after: $after) { nodes { id handle title body isPublished updatedAt } pageInfo { hasNextPage endCursor } } } } }`,
      { q: `handle:${handle}`, after });
    const blog = d.blogs.nodes.find((b) => b.handle === handle);
    if (!blog) break;
    for (const a of blog.articles.nodes) {
      if (!a.isPublished) continue;
      const source = `blog:${handle}:${a.id}`;
      seen.add(source);
      if (await upsert(env, source, a.title, clean(a.body ?? ""), `${STORE}/blogs/${handle}/${a.handle}`, "article")) n++;
    }
    if (!blog.articles.pageInfo.hasNextPage) break;
    after = blog.articles.pageInfo.endCursor;
  }
  const { results } = await env.DB.prepare("SELECT id, source FROM knowledge WHERE source LIKE ?").bind(`blog:${handle}:%`).all<{ id: number; source: string }>();
  for (const r of results) if (!seen.has(r.source)) await env.DB.prepare("DELETE FROM knowledge WHERE id = ?").bind(r.id).run();
  return n;
}

/** Stops using a blog: removes all of its articles from AI knowledge. */
export async function removeBlog(env: Env, handle: string) {
  const r = await env.DB.prepare("DELETE FROM knowledge WHERE source LIKE ?").bind(`blog:${handle}:%`).run();
  return { removed: r.meta.changes ?? 0 };
}

/** Refreshes everything that came from the website (the daily cron, or "Refresh now"). */
export async function refreshSources(env: Env) {
  const { results } = await env.DB.prepare("SELECT source FROM knowledge WHERE source IS NOT NULL").all<{ source: string }>();
  if (!results.length) return { refreshed: 0, errors: [] as string[] };
  const errors: string[] = [];
  let refreshed = 0;
  const shopSources = [...new Set(results.map((r) => r.source).filter((s) => !s.startsWith("url:")).map((s) => (s.startsWith("blog:") ? s.split(":").slice(0, 2).join(":") : s)))];
  try {
    refreshed += (await addSources(env, shopSources)).added;
  } catch (e) {
    errors.push((e as Error).message);
  }
  for (const r of results.filter((x) => x.source.startsWith("url:"))) {
    try {
      refreshed += (await addSources(env, [r.source])).added;
    } catch (e) {
      errors.push(`${r.source.slice(4)}: ${(e as Error).message}`);
    }
  }
  await setSetting(env, "site_knowledge_synced", nowIso());
  return { refreshed, errors };
}

/** Once a day, from the minute cron. */
export async function dailyRefresh(env: Env) {
  const last = await getSetting<string | null>(env, "site_knowledge_synced", null);
  if (last && Date.now() - Date.parse(last) < 24 * 3600_000) return;
  await setSetting(env, "site_knowledge_synced", nowIso()); // claim the run even if it fails
  await refreshSources(env);
}
