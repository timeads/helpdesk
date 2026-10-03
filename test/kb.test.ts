import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const shop = vi.hoisted(() => ({ calls: [] as { query: string; vars: any }[] }));
vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async (_env: unknown, query: string, vars: any) => {
    shop.calls.push({ query, vars });
    if (query.includes("KbBlog(")) return { blogs: { nodes: [] } };
    if (query.includes("blogCreate")) return { blogCreate: { blog: { id: "gid://shopify/Blog/9" }, userErrors: [] } };
    if (query.includes("articleCreate")) return { articleCreate: { article: { id: `gid://shopify/Article/${shop.calls.length}`, handle: vars.article.handle }, userErrors: [] } };
    if (query.includes("articleUpdate")) return { articleUpdate: { article: { id: vars.id, handle: "kept-handle" }, userErrors: [] } };
    throw new Error("unexpected " + query);
  }),
}));
const ai = vi.hoisted(() => ({ out: null as any, content: null as any }));
vi.mock("../src/lib/manual", () => ({ ask: vi.fn(async (_env: unknown, content: unknown) => { ai.content = content; return ai.out; }) }));

import { acceptSuggestion, cleanHtml, importKb, kbForAI, kbScanBatch, publishBatch, rankArticles } from "../src/lib/kb";

let env: any;
const IMG = "/9j/4AAQSkZJRgABAQ"; // a JPEG's first bytes
const FILE = {
  topics: [{ id: "getting-started", name: "Getting Started", icon: "🧵" }, { id: "troubleshoot", name: "Machine Troubleshooting", icon: "🔧" }],
  articles: [
    { id: "gs-overview", topic_id: "getting-started", title: "What Do You Need to Start Tufting?", html: `<p>You need a machine, cloth and yarn. See <a href="#ts-jam">jams</a>.</p><img src="data:image/jpeg;base64,${IMG}" alt="kit">` },
    { id: "ts-jam", topic_id: "troubleshoot", title: "AK-I Jamming After a Few Stitches", html: `<p onclick="x()">Lint on the blade causes jamming. Clean the blade and oil the spring.</p><script>alert(1)</script>` },
  ],
};
const one = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();

beforeEach(async () => {
  env = { DB: testD1() };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  shop.calls.length = 0;
  await importKb(env, FILE, 1);
});

describe("knowledge base", () => {
  it("keeps plain formatting and drops scripts, handlers and javascript: links", () => {
    expect(cleanHtml(`<p style="x" onclick="y()">Hi <a href="javascript:alert(1)">x</a> <a href="https://a.com">a</a></p><script>bad()</script>`))
      .toBe(`<p>Hi <a>x</a> <a href="https://a.com" target="_blank" rel="noopener">a</a></p>`);
  });

  it("imports topics and articles, moving photos out of the HTML", async () => {
    const a = await one("SELECT * FROM kb_articles WHERE id = 'gs-overview'");
    expect(a).toMatchObject({ topic_id: "getting-started", status: "published" });
    expect(a.body_html).toContain('src="/kb/img/1"');
    expect((await one("SELECT data FROM kb_images WHERE id = 1")).data).toBe(IMG);
    const j = await one("SELECT body_html, body_text FROM kb_articles WHERE id = 'ts-jam'");
    expect(j.body_html).not.toMatch(/script|onclick/);
    expect(j.body_text).toContain("Lint on the blade");
  });

  it("finds the articles that match a conversation", async () => {
    const all = (await env.DB.prepare("SELECT * FROM kb_articles").all()).results;
    expect(rankArticles(all, "my AK-I keeps jamming, what do I do?").map((a: any) => a.id)).toEqual(["ts-jam"]);
    expect(rankArticles(all, "hello thanks")).toEqual([]);
    const ctx = await kbForAI(env, "gun jamming");
    expect(ctx).toContain("AK-I Jamming After a Few Stitches");
    expect(ctx).toContain("Lint on the blade");
  });

  it("publishes each article as a store blog post with its own URL, description and topic tag", async () => {
    const r = await publishBatch(env, "https://helpdesk.example");
    expect(r).toEqual({ published: 2, remaining: 0 });
    const create = shop.calls.find((c) => c.query.includes("articleCreate") && c.vars.article.title.startsWith("What Do"))!.vars.article;
    expect(create).toMatchObject({ blogId: "gid://shopify/Blog/9", handle: "what-do-you-need-to-start-tufting", isPublished: true, tags: ["Knowledge Base", "Getting Started"] });
    expect(create.body).toContain('src="https://helpdesk.example/kb/img/1"');
    expect(create.body).toContain('href="/blogs/knowledge-base/ak-i-jamming-after-a-few-stitches"');
    expect(create.metafields.find((m: any) => m.key === "description_tag").value).toBe("You need a machine, cloth and yarn. See jams.");
    // Nothing changed → nothing to publish; an edit → an update, not a second copy
    expect((await publishBatch(env, "https://helpdesk.example")).published).toBe(0);
    await env.DB.prepare("UPDATE kb_articles SET title = 'Edited', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '+1 second') WHERE id = 'ts-jam'").run();
    shop.calls.length = 0;
    expect((await publishBatch(env, "https://helpdesk.example")).published).toBe(1);
    expect(shop.calls.map((c) => c.query.match(/article(Create|Update)/)?.[0])).toEqual(["articleUpdate"]);
  });

  it("files suggestions from conversations and adds an accepted one to its article", async () => {
    env.DB.raw.prepare("INSERT INTO tickets (id, subject, customer_email, status, created_at, last_message_at) VALUES (7, 'Jam', 'c@x.com', 'closed', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    env.DB.raw.prepare("INSERT INTO messages (ticket_id, direction, from_email, sent_at, body_text) VALUES (7, 'in', 'c@x.com', ?, 'Still jams'), (7, 'out', 's@x.com', ?, 'Check the needle depth is at 2.')").run(new Date().toISOString(), new Date().toISOString());
    ai.out = { suggestions: [{ article_id: "ts-jam", topic_id: "troubleshoot", title: "Check the needle depth", content_html: "<p>Set the needle depth to 2.</p><script>x</script>", reason: "Missing fix", ticket_ids: [7, 99] }] };
    const r = await kbScanBatch(env, 6);
    expect(r).toEqual({ read: 1, suggestions: 1, remaining: 0 });
    const s = await one("SELECT * FROM kb_suggestions");
    expect(s).toMatchObject({ article_id: "ts-jam", content_html: "<p>Set the needle depth to 2.</p>", ticket_ids: "[7]" });
    await acceptSuggestion(env, s.id, {}, 1);
    const a = await one("SELECT body_html FROM kb_articles WHERE id = 'ts-jam'");
    expect(a.body_html).toMatch(/<h3>Check the needle depth<\/h3>\s*<p>Set the needle depth to 2.<\/p>$/);
    await expect(acceptSuggestion(env, s.id, {}, 1)).rejects.toThrow(/already handled/);
  });
});

describe("accepting suggestions in bulk", () => {
  it("accepts every waiting suggestion in batches, keeping edits made on the page", async () => {
    const { Hono } = await import("hono");
    const { default: kbRoutes } = await import("../src/routes/kb");
    const app = new Hono();
    app.use("*", async (c: any, next) => { c.set("agent", { id: 1, name: "Tim", role: "admin" }); await next(); });
    app.route("/kb", kbRoutes as any);
    const ins = env.DB.raw.prepare("INSERT INTO kb_suggestions (article_id, topic_id, title, content_html, reason) VALUES (?, 'troubleshoot', ?, ?, 'r')");
    for (let i = 0; i < 35; i++) ins.run("ts-jam", `Tip ${i}`, `<p>Tip number ${i}.</p>`);
    ins.run(null, "Brand new guide", "<p>All about frames.</p>");
    const first = (await env.DB.prepare("SELECT id FROM kb_suggestions ORDER BY id LIMIT 1").first()).id;

    const post = async (body: unknown): Promise<any> => {
      const r = await app.request("/kb/suggestions/accept-all", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
      return r.json();
    };
    const edits = { [first]: { title: "Edited tip", content_html: "<p>Edited by Tim.</p>", article_id: "ts-jam" } };
    const a = await post({ edits });
    expect(a).toMatchObject({ accepted: 30, remaining: 6, failed: [] });
    const b = await post({ edits });
    expect(b).toMatchObject({ accepted: 6, remaining: 0 });

    const body = (await one("SELECT body_html FROM kb_articles WHERE id = 'ts-jam'")).body_html;
    expect(body).toContain("<h3>Edited tip</h3>");
    expect(body).toContain("Edited by Tim.");
    expect(body).not.toContain("Tip number 0.");
    expect(body).toContain("Tip number 34.");
    expect(await one("SELECT status FROM kb_articles WHERE title = 'Brand new guide'")).toEqual({ status: "draft" });
    expect((await one("SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'")).n).toBe(0);
  });
});
