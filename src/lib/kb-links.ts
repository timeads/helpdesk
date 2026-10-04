// Link check for the knowledge base: every link in every article is checked against what's really on
// the store (products, collections, pages, blog posts, redirects) and against the desk's own articles,
// with a suggested replacement for each broken one. Outside links are checked separately, a few at a time.
import type { Env } from "../env";
import { STORE_URL, cleanHtml, textOf, type KbArticle } from "./kb";
import { saveVersion } from "./kb-merge";
import { shopify } from "./shopify";
import { HttpError, getSetting, nowIso, setSetting } from "./util";

export interface StoreIndex {
  products: { handle: string; title: string; live: boolean; status: string }[];
  collections: Set<string>;
  pages: Map<string, boolean>; // handle → published
  blogs: Map<string, Map<string, { title: string; live: boolean }>>; // blog → article handle → …
  redirects: Map<string, string>; // lowercased path → target
  redirectsChecked: boolean;
}

export type LinkStatus = "broken" | "retired" | "redirect" | "old-domain" | "ok" | "external";

export interface LinkIssue {
  articleId: string;
  articleTitle: string;
  href: string;
  text: string;
  status: LinkStatus;
  problem: string;
  suggestion: { href: string; title: string } | null;
}

const STORE_HOSTS = new Set(["tufttheworld.com", "www.tufttheworld.com", "tuftinggun.com", "www.tuftinggun.com"]);
const ALWAYS_OK = /^\/(?:$|cart|search|account|policies\/|apps\/|collections\/all(?:$|\/)|tools\/|a\/|cdn\/|services\/)/;

/** All links in an article: href and the visible text. */
export function linksIn(html: string): { href: string; text: string }[] {
  return [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: m[1].replace(/&amp;/g, "&").trim(),
    text: m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  }));
}

const STOP = new Set("the a an and or of for with to in on our your tufting machine pile".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w)));

/** The closest live product to a dead handle (and the link's text), if any is close enough. */
export function closestProduct(index: StoreIndex, handle: string, text: string): { handle: string; title: string } | null {
  const want = new Set([...words(handle.replace(/-/g, " ")), ...words(text)]);
  if (!want.size) return null;
  let best: { handle: string; title: string; score: number } | null = null;
  for (const p of index.products) {
    if (!p.live) continue;
    const have = new Set([...words(p.handle.replace(/-/g, " ")), ...words(p.title)]);
    let hit = 0;
    for (const w of want) if (have.has(w)) hit++;
    const score = hit / Math.max(want.size, 1);
    if (hit && (!best || score > best.score)) best = { handle: p.handle, title: p.title, score };
  }
  return best && best.score >= 0.34 ? { handle: best.handle, title: best.title } : null;
}

/** One link checked against the store. Returns null when it's fine (or not ours to judge). */
export function checkLink(index: StoreIndex, href: string, text: string, deskIds: Set<string>): Omit<LinkIssue, "articleId" | "articleTitle" | "href" | "text"> | null {
  if (!href || /^(mailto:|tel:)/i.test(href)) return null;
  if (href.startsWith("#")) {
    return deskIds.has(href.slice(1)) ? null : { status: "broken", problem: "Links to an article that's no longer in the knowledge base", suggestion: null };
  }
  let url: URL;
  try {
    url = new URL(href, STORE_URL);
  } catch {
    return { status: "broken", problem: "Not a valid web address", suggestion: null };
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const relative = href.startsWith("/");
  if (!relative && !STORE_HOSTS.has(url.hostname.toLowerCase())) return { status: "external", problem: "Outside link", suggestion: null };

  const path = decodeURIComponent(url.pathname).replace(/\/+$/, "").toLowerCase() || "/";
  const keep = url.search + url.hash;
  const local = (p: string) => p + keep;
  const oldDomain = !relative && url.hostname.toLowerCase().includes("tuftinggun");

  const redirect = index.redirects.get(path);
  if (redirect) {
    const target = redirect.replace(/^https?:\/\/(www\.)?tufttheworld\.com/i, "");
    return { status: "redirect", problem: `Redirects to ${target} — link there directly`, suggestion: { href: target, title: target } };
  }

  const parts = path.split("/").filter(Boolean);
  let problem: string | null = null;
  let suggestion: LinkIssue["suggestion"] = null;
  let status: LinkStatus = "broken";

  const productHandle = parts[0] === "products" ? parts[1] : parts[0] === "collections" && parts[2] === "products" ? parts[3] : null;
  if (productHandle) {
    const p = index.products.find((x) => x.handle === productHandle);
    if (!p || !p.live) {
      const near = closestProduct(index, productHandle, text);
      suggestion = near ? { href: `/products/${near.handle}`, title: near.title } : null;
      problem = p ? `Product "${p.title}" is ${p.status === "ACTIVE" ? "not on the online store" : p.status.toLowerCase()}` : "No product at this address (404)";
      status = p ? "retired" : "broken";
    }
  } else if (parts[0] === "collections" && parts[1] && parts[1] !== "all") {
    if (!index.collections.has(parts[1])) problem = "No collection at this address (404)";
  } else if (parts[0] === "pages" && parts[1]) {
    const live = index.pages.get(parts[1]);
    if (live === undefined) problem = "No page at this address (404)";
    else if (!live) { problem = "This page is hidden on the store"; status = "retired"; }
  } else if (parts[0] === "blogs" && parts[1]) {
    const blog = index.blogs.get(parts[1]);
    if (!blog) problem = "No blog at this address (404)";
    else if (parts[2] && parts[2] !== "tagged") {
      const a = blog.get(parts[2]);
      if (!a) problem = "No blog post at this address (404)";
      else if (!a.live) { problem = `The post "${a.title}" is hidden on the store`; status = "retired"; }
    }
  } else if (!ALWAYS_OK.test(path)) {
    problem = index.redirectsChecked ? "Not a known store address (likely 404)" : null;
  }

  if (problem) return { status, problem, suggestion: suggestion ? { ...suggestion, href: local(suggestion.href) } : null };
  if (oldDomain) return { status: "old-domain", problem: "Uses the old tuftinggun.com address — works through a redirect", suggestion: { href: local(path === "/" ? "/" : url.pathname), title: url.pathname } };
  return null;
}

/** Everything on the store a link can point to. */
export async function loadStoreIndex(env: Env): Promise<StoreIndex> {
  const products: StoreIndex["products"] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d: any = await shopify(env, `query LinkProducts($after: String) { products(first: 250, after: $after) { nodes { handle title status onlineStoreUrl } pageInfo { hasNextPage endCursor } } }`, { after });
    for (const p of d.products.nodes) products.push({ handle: p.handle, title: p.title, status: p.status, live: p.status === "ACTIVE" && !!p.onlineStoreUrl });
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const site: any = await shopify(env, `query LinkSite { collections(first: 250) { nodes { handle title } } pages(first: 250) { nodes { handle title isPublished } } blogs(first: 50) { nodes { handle title articles(first: 250) { nodes { handle title isPublished } } } } }`);
  const redirects = new Map<string, string>();
  let redirectsChecked = true;
  try {
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const d: any = await shopify(env, `query LinkRedirects($after: String) { urlRedirects(first: 250, after: $after) { nodes { path target } pageInfo { hasNextPage endCursor } } }`, { after: cursor });
      for (const r of d.urlRedirects.nodes) redirects.set(String(r.path).replace(/\/+$/, "").toLowerCase(), r.target);
      if (!d.urlRedirects.pageInfo.hasNextPage) break;
      cursor = d.urlRedirects.pageInfo.endCursor;
    }
  } catch {
    redirectsChecked = false; // the app may not have read_online_store_navigation
  }
  return {
    products,
    collections: new Set(site.collections.nodes.map((c: any) => c.handle)),
    pages: new Map(site.pages.nodes.map((p: any) => [p.handle, !!p.isPublished])),
    blogs: new Map(site.blogs.nodes.map((b: any) => [b.handle, new Map(b.articles.nodes.map((a: any) => [a.handle, { title: a.title, live: !!a.isPublished }]))])),
    redirects,
    redirectsChecked,
  };
}

export interface LinkReport {
  at: string;
  articles: number;
  links: number;
  issues: LinkIssue[];
  external: { articleId: string; href: string; text: string }[];
  externalChecked: number;
  redirectsChecked: boolean;
}

/** Checks every link in every article (published and draft) and saves the report. */
export async function checkKbLinks(env: Env): Promise<LinkReport> {
  const index = await loadStoreIndex(env);
  const { results: articles } = await env.DB.prepare("SELECT id, title, body_html FROM kb_articles").all<Pick<KbArticle, "id" | "title" | "body_html">>();
  const deskIds = new Set(articles.map((a) => a.id));
  const issues: LinkIssue[] = [];
  const external: LinkReport["external"] = [];
  let links = 0;
  for (const a of articles) {
    const seen = new Set<string>();
    for (const l of linksIn(a.body_html)) {
      links++;
      if (seen.has(l.href)) continue;
      seen.add(l.href);
      const r = checkLink(index, l.href, l.text, deskIds);
      if (!r) continue;
      if (r.status === "external") external.push({ articleId: a.id, href: l.href, text: l.text });
      else issues.push({ articleId: a.id, articleTitle: a.title, href: l.href, text: l.text, ...r });
    }
  }
  const order: Record<string, number> = { broken: 0, retired: 1, redirect: 2, "old-domain": 3 };
  issues.sort((x, y) => (order[x.status] ?? 9) - (order[y.status] ?? 9) || x.articleTitle.localeCompare(y.articleTitle));
  const report: LinkReport = { at: nowIso(), articles: articles.length, links, issues, external, externalChecked: 0, redirectsChecked: index.redirectsChecked };
  await setSetting(env, "kb_link_report", report);
  return report;
}

export const linkReport = (env: Env) => getSetting<LinkReport | null>(env, "kb_link_report", null);

/** Checks the next few outside links (a dead site or page shows up as broken). */
export async function checkExternalBatch(env: Env, size = 12): Promise<{ checked: number; remaining: number; found: number }> {
  const report = await linkReport(env);
  if (!report) throw new HttpError(409, "Run the link check first");
  const batch = report.external.slice(report.externalChecked, report.externalChecked + size);
  const titles = new Map(report.issues.map((i) => [i.articleId, i.articleTitle]));
  const { results } = batch.length ? await env.DB.prepare(`SELECT id, title FROM kb_articles WHERE id IN (${batch.map(() => "?").join(",")})`).bind(...batch.map((b) => b.articleId)).all<{ id: string; title: string }>() : { results: [] };
  for (const r of results) titles.set(r.id, r.title);
  let found = 0;
  await Promise.all(batch.map(async (l) => {
    let status = 0;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      let r = await fetch(l.href, { method: "HEAD", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "TuftTheWorld-LinkCheck/1.0" } });
      if (r.status === 405 || r.status === 403) r = await fetch(l.href, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "user-agent": "TuftTheWorld-LinkCheck/1.0" } });
      clearTimeout(t);
      status = r.status;
    } catch {
      status = -1;
    }
    if (status === 404 || status === 410 || status === -1) {
      found++;
      report.issues.push({ articleId: l.articleId, articleTitle: titles.get(l.articleId) ?? l.articleId, href: l.href, text: l.text, status: "broken",
        problem: status === -1 ? "The site didn't answer (it may be gone)" : `The page is gone (${status})`, suggestion: null });
    }
  }));
  report.externalChecked += batch.length;
  await setSetting(env, "kb_link_report", report);
  return { checked: batch.length, remaining: report.external.length - report.externalChecked, found };
}

export interface LinkFix { articleId: string; href: string; to: string | null } // to = null: remove the link, keep its words

/** Applies fixes (saving each article's earlier version first). The articles then need publishing. */
export async function applyLinkFixes(env: Env, fixes: LinkFix[], agentId: number) {
  const byArticle = new Map<string, LinkFix[]>();
  for (const f of fixes) {
    if (f.to !== null && !/^(https?:\/\/|\/|#|mailto:)/i.test(f.to)) throw new HttpError(400, `"${f.to}" isn't a web address or store path`);
    byArticle.set(f.articleId, [...(byArticle.get(f.articleId) ?? []), f]);
  }
  let changed = 0;
  for (const [id, list] of byArticle) {
    const a = await env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(id).first<KbArticle>();
    if (!a) continue;
    let html = a.body_html;
    for (const f of list) {
      const esc = f.href.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const plain = f.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`<a\\b([^>]*)\\bhref="(?:${esc}|${plain})"([^>]*)>([\\s\\S]*?)</a>`, "g");
      html = html.replace(re, (_m, pre: string, post: string, inner: string) =>
        f.to === null ? inner : `<a${pre}href="${f.to.replace(/"/g, "&quot;")}"${post}>${inner}</a>`);
    }
    html = cleanHtml(html);
    if (html === a.body_html) continue;
    await saveVersion(env, a, "Before fixing links", agentId);
    await env.DB.prepare("UPDATE kb_articles SET body_html = ?, body_text = ?, edited_by = ?, updated_at = ? WHERE id = ?").bind(html, textOf(html), agentId, nowIso(), id).run();
    changed++;
  }
  // Drop the fixed links from the saved report
  const report = await linkReport(env);
  if (report) {
    const done = new Set(fixes.map((f) => `${f.articleId} ${f.href}`));
    report.issues = report.issues.filter((i) => !done.has(`${i.articleId} ${i.href}`));
    await setSetting(env, "kb_link_report", report);
  }
  return { articles: changed };
}

