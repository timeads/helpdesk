import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const store = vi.hoisted(() => ({ kb: [] as any[], blog: [] as any[], tech: [] as any[] }));
vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async (_env: unknown, query: string, vars: any) => {
    if (query.includes("KbPull")) return { blog: { articles: { nodes: vars.id === "B2" ? store.tech : store.kb, pageInfo: { hasNextPage: false, endCursor: "" } } } };
    if (query.includes("KbBlog(")) return { blogs: { nodes: vars.q === "handle:tech-support" ? [{ id: "B2", handle: "tech-support", title: "Tech Support" }] : [] } };
    if (query.includes("SiteBlogArticles")) return { blogs: { nodes: [{ id: "b1", handle: vars.q.slice(7), title: "Tech Support", articles: { nodes: store.blog, pageInfo: { hasNextPage: false } } }] } };
    throw new Error(query);
  }),
}));
vi.mock("../src/lib/manual", () => ({ ask: vi.fn() }));

import { cleanHtml, importKb, kbForAI, kbRestyle, kbRestyleCount, kbUnsynced, storeBody, styleForStore } from "../src/lib/kb";
import { fromStoreBody, pullFromStore } from "../src/lib/kb-pull";
import { addSources, refreshSources } from "../src/lib/site-knowledge";
import { versionsOf } from "../src/lib/kb-merge";

let env: any;
const one = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();

beforeEach(async () => {
  env = { DB: testD1() };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('kb_blog_id', '\"gid://shopify/Blog/9\"')").run();
  await importKb(env, {
    topics: [{ id: "troubleshoot", name: "Machine Troubleshooting" }, { id: "yarn", name: "Yarn & Fiber" }],
    articles: [
      { id: "jam", topic_id: "troubleshoot", title: "Jams", html: "<p>Old text.</p>" },
      { id: "yarn", topic_id: "yarn", title: "Yarn", html: "<p>Merged away on the store.</p>" },
      { id: "draft", topic_id: "yarn", title: "Local draft", html: "<p>Never published.</p>" },
    ],
  }, 1);
  await env.DB.prepare("UPDATE kb_articles SET shopify_id = 'A1', shopify_handle = 'fixing-jams', synced_at = updated_at WHERE id = 'jam'").run();
  await env.DB.prepare("UPDATE kb_articles SET shopify_id = 'A2', shopify_handle = 'yarn', synced_at = updated_at WHERE id = 'yarn'").run();
  await env.DB.prepare("UPDATE kb_articles SET status = 'draft' WHERE id = 'draft'").run();
  store.kb = [
    { id: "A1", handle: "fixing-jams", title: "Fixing a jammed gun", tags: ["Knowledge Base", "Machine Troubleshooting"], isPublished: true, updatedAt: "2026-10-03",
      body: `<p style="color:red">New text from the store. See <a href="https://tufttheworld.com/blogs/knowledge-base/workshops-in-philly">workshops</a>.</p><img src="https://helpdesk.example/kb/img/1" alt="x">`,
      description: { value: "How to fix a jam." } },
    { id: "A3", handle: "workshops-in-philly", title: "Workshops in Philly", tags: ["Workshops", "Knowledge Base"], isPublished: true, updatedAt: "2026-10-03",
      body: "<p>Classes every weekend.</p>", description: null },
  ];
});

describe("updating the knowledge base from the store", () => {
  it("turns store links and our photo URLs back into the desk's", () => {
    const m = new Map([["knowledge-base/workshops-in-philly", "workshops"]]);
    expect(fromStoreBody(`<a href="/blogs/knowledge-base/workshops-in-philly">x</a><img src="https://helpdesk.example/kb/img/4">`, m))
      .toBe(`<a href="#workshops">x</a><img src="/kb/img/4">`);
  });

  it("styles tables, tips and photo rows for the store, and takes the styling back off on the way in", () => {
    const desk = `<table><thead><tr><th>Cloth</th><th>Pieces</th></tr></thead><tbody><tr><th colspan="2">1 yard</th></tr><tr><td>30 × 30</td><td>4</td></tr><tr><td>48 × 30</td><td>3</td></tr></tbody></table>`
      + `<p class="kb-tip">Tack points away from the center.</p><div class="kb-gallery"><figure><img src="/kb/img/2" alt="a"><figcaption>Step 1</figcaption></figure></div>`;
    const out = storeBody(desk, "https://helpdesk.example", new Map());
    expect(out).toMatch(/^<div class="kb-table-wrap" style="overflow-x:auto/);
    expect(out).toContain(`<th style="text-align:left;padding:12px 14px;background:rgba(0,0,0,.06)`);
    expect(out).toMatch(/<th style="text-align:left;padding:10px 14px;background:rgba\(0,0,0,.035\)[^"]*" colspan="2">1 yard/);
    expect(out.match(/<tr style="background:rgba\(0,0,0,.025\)">/g)).toHaveLength(1); // every other body row
    expect(out).toContain(`<p class="kb-tip" style="padding:14px 18px`);
    expect(out).toContain(`<figure style="flex:1 1 220px;margin:0;min-width:0"><img style="max-width:100%`);
    expect(out).toContain(`src="https://helpdesk.example/kb/img/2"`);
    expect(cleanHtml(fromStoreBody(out, new Map()))).toBe(desk);
    expect(styleForStore(`<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>`)).toContain(`<th style="text-align:left;padding:12px 14px`);
  });

  it("keeps desk edits that aren't published yet instead of overwriting them with the store's copy", async () => {
    await env.DB.prepare("UPDATE kb_articles SET body_html = '<p>Rewritten in the desk.</p>', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = 'jam'").run();
    const r = await pullFromStore(env, 1);
    expect(r).toMatchObject({ kept: 1, updated: 0 });
    expect((await one("SELECT body_html FROM kb_articles WHERE id = 'jam'")).body_html).toBe("<p>Rewritten in the desk.</p>");
    expect(await kbUnsynced(env)).toBeGreaterThanOrEqual(1); // still waiting to be published
  });

  it("queues store articles with tables for republishing once, so they pick up the new table style", async () => {
    await env.DB.prepare("UPDATE kb_articles SET body_html = '<table><tr><td>1</td></tr></table>' WHERE id = 'jam'").run();
    await env.DB.prepare("UPDATE kb_articles SET synced_at = updated_at WHERE id = 'jam'").run();
    expect(await kbRestyleCount(env)).toBe(1);
    const before = await kbUnsynced(env);
    expect(await kbRestyle(env)).toEqual({ marked: 1 });
    expect(await kbUnsynced(env)).toBe(before + 1);
    expect(await kbRestyleCount(env)).toBe(0); // done for this style version
  });

  it("store edits win, new store articles come in, deleted ones go, and local drafts stay", async () => {
    const r = await pullFromStore(env, 1);
    expect(r).toMatchObject({ updated: 1, added: 1, removed: 1, unchanged: 0, topicsAdded: 1, onStore: 2, blogs: { "knowledge-base": 2 } });
    const jam = await one("SELECT * FROM kb_articles WHERE id = 'jam'");
    expect(jam).toMatchObject({ title: "Fixing a jammed gun", description: "How to fix a jam.", status: "published" });
    expect(jam.body_html).toBe(`<p>New text from the store. See <a href="#workshops-in-philly">workshops</a>.</p><img src="/kb/img/1" alt="x">`);
    expect(jam.synced_at).toBe(jam.updated_at); // nothing to publish back
    expect(await one("SELECT topic_id, shopify_id FROM kb_articles WHERE id = 'workshops-in-philly'")).toEqual({ topic_id: "workshops", shopify_id: "A3" });
    expect(await one("SELECT name FROM kb_topics WHERE id = 'workshops'")).toEqual({ name: "Workshops" });
    expect(await one("SELECT id FROM kb_articles WHERE id = 'yarn'")).toBeNull();
    expect(await one("SELECT status FROM kb_articles WHERE id = 'draft'")).toEqual({ status: "draft" });
    expect((await versionsOf(env, "jam"))[0]).toMatchObject({ reason: "Before updating from the store" });
    expect((await versionsOf(env, "yarn"))[0]).toMatchObject({ reason: "Removed: no longer on the store" });
    // Running it again changes nothing
    expect(await pullFromStore(env, 1)).toMatchObject({ updated: 0, added: 0, removed: 0, unchanged: 2 });
  });

  it("gives the AI the store's other blogs: looked up when relevant, kept in sync", async () => {
    store.blog = [
      { id: "P1", handle: "white-gear-fix", title: "Replacing the white gear", body: "<p>Unscrew the cover and replace the white gear.</p>", isPublished: true },
      { id: "P2", handle: "hidden", title: "Unpublished", body: "<p>x</p>", isPublished: false },
    ];
    expect(await addSources(env, ["blog:tech-support"])).toEqual({ added: 1 });
    expect(await one("SELECT name, type, source_url FROM knowledge WHERE source = 'blog:tech-support:P1'"))
      .toEqual({ name: "Replacing the white gear", type: "article", source_url: "https://tufttheworld.com/blogs/tech-support/white-gear-fix" });
    expect(await kbForAI(env, "my white gear broke")).toContain("Unscrew the cover");
    store.blog = []; // deleted on the store
    await refreshSources(env);
    expect(await one("SELECT COUNT(*) AS n FROM knowledge")).toEqual({ n: 0 });
  });

  it("manages older blogs in place: same blog and address, own tags, and no duplicate read-only copy for the AI", async () => {
    store.blog = [{ id: "P1", handle: "white-gear-fix", title: "Replacing the white gear", body: "<p>Old AI copy.</p>", isPublished: true }];
    await addSources(env, ["blog:tech-support"]); // was read-only AI knowledge before
    store.tech = [{ id: "T1", handle: "how-to-finish-a-tufted-rug", title: "How to Finish a Tufted Rug", tags: ["finishing", "guide"], isPublished: true, updatedAt: "2026-10-04",
      body: `<p>Glue, then back. See <a href="/blogs/knowledge-base/fixing-jams">jams</a>.</p>`, description: null }];
    const r = await pullFromStore(env, 1, ["tech-support"]);
    expect(r.blogs).toEqual({ "knowledge-base": 2, "tech-support": 1 });
    const a = await one("SELECT * FROM kb_articles WHERE shopify_id = 'T1'");
    expect(a).toMatchObject({ blog_handle: "tech-support", shopify_handle: "how-to-finish-a-tufted-rug", topic_id: "troubleshoot", store_tags: '["finishing","guide"]' });
    expect(a.body_html).toContain('href="#jam"'); // link to a managed article, mapped back
    expect(await one("SELECT COUNT(*) AS n FROM knowledge WHERE source LIKE 'blog:tech-support:%'")).toEqual({ n: 0 });

    // Publishing an edit updates the post in its own blog, keeping its tags and address
    const { publishBatch } = await import("../src/lib/kb");
    const { shopify } = await import("../src/lib/shopify");
    (shopify as any).mockImplementation(async (_e: unknown, q: string, vars: any) => {
      if (q.includes("articleUpdate")) return { articleUpdate: { article: { id: vars.id, handle: "how-to-finish-a-tufted-rug" }, userErrors: [] } };
      return {};
    });
    await env.DB.prepare("UPDATE kb_articles SET body_html = '<p>Edited. See <a href=\"#jam\">jams</a>.</p>', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE shopify_id = 'T1'").run();
    expect((await publishBatch(env, "https://helpdesk.example")).published).toBe(1);
    const call = (shopify as any).mock.calls.find((c: any[]) => String(c[1]).includes("articleUpdate"));
    expect(call[2].article.tags).toEqual(["finishing", "guide"]);
    expect(call[2].article.body).toContain('href="/blogs/knowledge-base/fixing-jams"');
  });
});
