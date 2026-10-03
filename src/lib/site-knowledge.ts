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
  const d = await shopify<{ shop: { shopPolicies: Policy[] }; pages: { nodes: Page[] } }>(
    env,
    `query SiteSources { shop { shopPolicies { id type title body url updatedAt } } pages(first: 100, sortKey: TITLE) { nodes { id title handle isPublished updatedAt bodySummary } } }`,
  );
  const { results } = await env.DB.prepare("SELECT source FROM knowledge WHERE source IS NOT NULL").all<{ source: string }>();
  const added = new Set(results.map((r) => r.source));
  return {
    policies: d.shop.shopPolicies.filter((p) => p.body?.trim()).map((p) => ({ source: `policy:${p.type}`, title: p.title, url: p.url, added: added.has(`policy:${p.type}`) })),
    pages: d.pages.nodes.filter((p) => p.isPublished !== false).map((p) => ({
      source: `page:${p.id}`, title: p.title, url: `${STORE}/pages/${p.handle}`, summary: (p.bodySummary ?? "").slice(0, 140), added: added.has(`page:${p.id}`),
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

/** Refreshes everything that came from the website (the daily cron, or "Refresh now"). */
export async function refreshSources(env: Env) {
  const { results } = await env.DB.prepare("SELECT source FROM knowledge WHERE source IS NOT NULL").all<{ source: string }>();
  if (!results.length) return { refreshed: 0, errors: [] as string[] };
  const errors: string[] = [];
  let refreshed = 0;
  const shopSources = results.map((r) => r.source).filter((s) => !s.startsWith("url:"));
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
