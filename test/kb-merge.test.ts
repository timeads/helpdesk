import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const ai = vi.hoisted(() => ({ queue: [] as any[], calls: [] as any[] }));
vi.mock("../src/lib/manual", () => ({ ask: vi.fn(async (_env: unknown, content: any) => { ai.calls.push(content); return ai.queue.shift(); }) }));
vi.mock("../src/lib/shopify", () => ({ shopify: vi.fn(async () => ({})) }));

import { importKb } from "../src/lib/kb";
import { autoMergeTick, findDuplicates, integrateSuggestions, mergeArticles, restoreVersion, versionsOf } from "../src/lib/kb-merge";

let env: any;
const one = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();
const all = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).all().then((r: any) => r.results);

beforeEach(async () => {
  env = { DB: testD1(), ANTHROPIC_API_KEY: "k" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  ai.queue = [];
  ai.calls = [];
  await importKb(env, {
    topics: [{ id: "troubleshoot", name: "Troubleshooting" }, { id: "yarn", name: "Yarn" }],
    articles: [
      { id: "jam", topic_id: "troubleshoot", title: "Fixing a jammed AK-I", html: `<p>Clean the blade.</p><p><img src="data:image/jpeg;base64,/9j/AAAA" alt="blade"></p>` },
      { id: "jam-2", topic_id: "troubleshoot", title: "AK-I keeps jamming", html: "<p>Oil the spring.</p>" },
      { id: "yarn", topic_id: "yarn", title: "Choosing yarn", html: "<p>Wool works best.</p>" },
    ],
  }, 1);
  await env.DB.prepare("UPDATE kb_articles SET status = 'draft' WHERE id = 'jam'").run();
});

describe("knowledge base clean-up", () => {
  it("keeps only real duplicate sets from the AI's answer", async () => {
    ai.queue.push({ groups: [
      { keep: "jam", merge: ["jam-2", "jam", "ghost"], title: "Fixing a jammed AK-I", reason: "Both about AK-I jams" },
      { keep: "yarn", merge: ["jam-2"], title: "x", reason: "already used" },
      { keep: "nope", merge: ["yarn"], title: "x", reason: "unknown keep" },
    ] });
    expect(await findDuplicates(env)).toEqual([{ keep: "jam", merge: ["jam-2"], title: "Fixing a jammed AK-I", reason: "Both about AK-I jams" }]);
  });

  it("merges a set into one article, keeping photos, saving versions and moving suggestions over", async () => {
    await env.DB.prepare("INSERT INTO kb_suggestions (article_id, topic_id, title, content_html) VALUES ('jam-2', 'troubleshoot', 't', '<p>x</p>')").run();
    ai.queue.push({ title: "How to fix a jammed AK-I", description: "Clean the blade and oil the spring.",
      body_html: `<h3>Fix it</h3><ol><li>Clean the blade.</li><li>Oil the spring.</li></ol><img src="https://evil.example/x.png">` });
    const r = await mergeArticles(env, "jam", ["jam-2"], 1);
    expect(r).toMatchObject({ merged: 1, title: "How to fix a jammed AK-I" });
    const a = await one("SELECT * FROM kb_articles WHERE id = 'jam'");
    expect(a.title).toBe("How to fix a jammed AK-I");
    expect(a.status).toBe("published"); // one of the set was published
    expect(a.body_html).toContain("Oil the spring.");
    expect(a.body_html).not.toContain("evil.example"); // only photos from the originals
    expect(a.body_html).toContain('src="/kb/img/1"'); // the original photo wasn't lost
    expect(await one("SELECT id FROM kb_articles WHERE id = 'jam-2'")).toBeNull();
    expect((await one("SELECT article_id FROM kb_suggestions")).article_id).toBe("jam");
    expect((await versionsOf(env, "jam-2")).length).toBe(1);

    // Undo: the merged-away article comes back as a draft
    const v = (await versionsOf(env, "jam-2"))[0] as any;
    await restoreVersion(env, v.id, 1);
    expect(await one("SELECT status, body_html FROM kb_articles WHERE id = 'jam-2'")).toMatchObject({ status: "draft", body_html: "<p>Oil the spring.</p>" });
  });

  it("folds suggestions into the right article once, and turns new subjects into one draft", async () => {
    const ins = env.DB.raw.prepare("INSERT INTO kb_suggestions (article_id, topic_id, title, content_html) VALUES (?, ?, ?, ?)");
    ins.run("jam", "troubleshoot", "Check the needle", "<p>Set the needle depth to 13.</p>");
    ins.run(null, "troubleshoot", "Needle depth", "<p>Needle depth 13 or 14.</p>");
    ins.run(null, "yarn", "Acrylic yarn", "<p>Acrylic is fine.</p>");
    ins.run(null, "yarn", "Is acrylic OK?", "<p>Acrylic sheds more.</p>");
    ai.queue.push({ routes: [
      { suggestion_id: 2, article_id: "jam", new_title: "" },
      { suggestion_id: 3, article_id: "", new_title: "Can I use acrylic yarn?" },
      { suggestion_id: 4, article_id: "", new_title: "Can I use acrylic yarn?" },
    ] });
    ai.queue.push({ title: "Can I use acrylic yarn?", description: "", body_html: "<p>Acrylic is fine but sheds more.</p>" }); // the new article
    ai.queue.push({ title: "Fixing a jammed AK-I", description: "", body_html: "<p>Clean the blade. Set the needle depth to 13 (or 14).</p>" }); // the rewrite
    const r = await integrateSuggestions(env, 1, 2);
    expect(r).toEqual({ updated: 1, created: 1, folded: 2, remaining: 0 });
    const jam = await one("SELECT body_html FROM kb_articles WHERE id = 'jam'");
    expect(jam.body_html).toContain("needle depth to 13");
    expect(jam.body_html).toContain('src="/kb/img/1"'); // photo the rewrite dropped is put back
    expect(await one("SELECT status, title FROM kb_articles WHERE id = 'can-i-use-acrylic-yarn'")).toEqual({ status: "draft", title: "Can I use acrylic yarn?" });
    expect((await all("SELECT status FROM kb_suggestions")).every((s: any) => s.status === "accepted")).toBe(true);
    expect((await versionsOf(env, "jam"))[0]).toMatchObject({ reason: "Before adding 2 suggestions from support conversations" });
  });

  it("auto-merge does nothing until it's switched on, then one step per 10 minutes", async () => {
    env.DB.raw.prepare("INSERT INTO kb_suggestions (article_id, topic_id, title, content_html) VALUES ('yarn', 'yarn', 'Wool', '<p>Wool lasts longer.</p>')").run();
    await autoMergeTick(env);
    expect(ai.calls).toHaveLength(0);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('kb_auto_merge', 'true')").run();
    ai.queue.push({ title: "Choosing yarn", description: "", body_html: "<p>Wool works best and lasts longer.</p>" });
    await autoMergeTick(env);
    expect(ai.calls).toHaveLength(1);
    expect((await one("SELECT body_html FROM kb_articles WHERE id = 'yarn'")).body_html).toContain("lasts longer");
    await autoMergeTick(env); // too soon
    expect(ai.calls).toHaveLength(1);
  });
});
