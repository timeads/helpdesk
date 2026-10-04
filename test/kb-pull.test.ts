import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const store = vi.hoisted(() => ({ kb: [] as any[], blog: [] as any[] }));
vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async (_env: unknown, query: string, vars: any) => {
    if (query.includes("KbPull")) return { blog: { articles: { nodes: store.kb, pageInfo: { hasNextPage: false, endCursor: "" } } } };
    if (query.includes("SiteBlogArticles")) return { blogs: { nodes: [{ id: "b1", handle: vars.q.slice(7), title: "Tech Support", articles: { nodes: store.blog, pageInfo: { hasNextPage: false } } }] } };
    throw new Error(query);
  }),
}));
vi.mock("../src/lib/manual", () => ({ ask: vi.fn() }));

import { importKb, kbForAI } from "../src/lib/kb";
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
    const m = new Map([["workshops-in-philly", "workshops"]]);
    expect(fromStoreBody(`<a href="/blogs/knowledge-base/workshops-in-philly">x</a><img src="https://helpdesk.example/kb/img/4">`, m))
      .toBe(`<a href="#workshops">x</a><img src="/kb/img/4">`);
  });

  it("store edits win, new store articles come in, deleted ones go, and local drafts stay", async () => {
    const r = await pullFromStore(env, 1);
    expect(r).toEqual({ updated: 1, added: 1, removed: 1, unchanged: 0, topicsAdded: 1, onStore: 2 });
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
});
