import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async (_env: unknown, query: string) => {
    if (query.includes("LinkProducts")) return { products: { nodes: [
      { handle: "the-duo", title: "The Duo — Cut & Loop Pile Tufting Machine", status: "ACTIVE", onlineStoreUrl: "https://tufttheworld.com/products/the-duo" },
      { handle: "kit-with-frame-tufting-machine-and-cloth", title: "Tufting Starter Kit (Frame, Tufting Machine, and Cloth)", status: "ACTIVE", onlineStoreUrl: "u" },
      { handle: "tufting-starter-kit-the-duo-frame-tufting-machine-and-gray-cloth", title: "Tufting Starter Kit (Frame, Tufting Machine, and Gray Cloth)", status: "ARCHIVED", onlineStoreUrl: null },
      { handle: "cut-pile-tufting-gun", title: "AK-I Cut-Pile Tufting Machine", status: "ARCHIVED", onlineStoreUrl: null },
    ], pageInfo: { hasNextPage: false, endCursor: "" } } };
    if (query.includes("LinkSite")) return {
      collections: { nodes: [{ handle: "yarn", title: "Yarn" }] },
      pages: { nodes: [{ handle: "contact-us", title: "Contact", isPublished: true }, { handle: "old-promo", title: "Promo", isPublished: false }] },
      blogs: { nodes: [{ handle: "knowledge-base", title: "Knowledge Base", articles: { nodes: [{ handle: "jams", title: "Jams", isPublished: true }] } }] },
    };
    if (query.includes("LinkRedirects")) return { urlRedirects: { nodes: [{ path: "/products/duo", target: "/products/the-duo" }], pageInfo: { hasNextPage: false, endCursor: "" } } };
    throw new Error(query);
  }),
}));

import { applyLinkFixes, checkKbLinks, checkLink, closestProduct, linkReport, loadStoreIndex } from "../src/lib/kb-links";
import { importKb } from "../src/lib/kb";

let env: any;
const one = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();

beforeEach(async () => {
  env = { DB: testD1() };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  await importKb(env, {
    topics: [{ id: "machines", name: "Machines" }],
    articles: [
      { id: "pick", topic_id: "machines", title: "Picking a machine", html:
        `<p>Try <a href="/products/the-duo-tufting-machine">the Duo</a>, or <a href="https://tufttheworld.com/products/duo">this one</a>.</p>` +
        `<p>Old kit: <a href="/products/tufting-starter-kit-the-duo-frame-tufting-machine-and-gray-cloth">starter kit</a>. ` +
        `<a href="https://tuftinggun.com/collections/yarn?sort=new">Yarn</a>, <a href="/pages/contact-us">contact</a>, <a href="/pages/old-promo">promo</a>, ` +
        `<a href="/blogs/knowledge-base/jams">jams</a>, <a href="/blogs/knowledge-base/gone">gone</a>, <a href="#missing">see this</a>, <a href="https://youtube.com/x">video</a>.</p>` },
    ],
  }, 1);
});

describe("checking knowledge base links", () => {
  it("finds broken, retired, redirected and old-domain links, with fixes", async () => {
    const r = await checkKbLinks(env);
    expect(r).toMatchObject({ articles: 1, links: 10, redirectsChecked: true, external: [{ href: "https://youtube.com/x" }] });
    const by = Object.fromEntries(r.issues.map((i) => [i.href, i]));
    expect(by["/products/the-duo-tufting-machine"]).toMatchObject({ status: "broken", suggestion: { href: "/products/the-duo" } });
    expect(by["https://tufttheworld.com/products/duo"]).toMatchObject({ status: "redirect", suggestion: { href: "/products/the-duo" } });
    expect(by["/products/tufting-starter-kit-the-duo-frame-tufting-machine-and-gray-cloth"]).toMatchObject({
      status: "retired", problem: 'Product "Tufting Starter Kit (Frame, Tufting Machine, and Gray Cloth)" is archived', suggestion: { href: "/products/kit-with-frame-tufting-machine-and-cloth" } });
    expect(by["https://tuftinggun.com/collections/yarn?sort=new"]).toMatchObject({ status: "old-domain", suggestion: { href: "/collections/yarn?sort=new" } });
    expect(by["/pages/old-promo"]).toMatchObject({ status: "retired" });
    expect(by["/blogs/knowledge-base/gone"]).toMatchObject({ status: "broken", problem: "No blog post at this address (404)" });
    expect(by["#missing"]).toMatchObject({ status: "broken" });
    expect(by["/pages/contact-us"]).toBeUndefined();
    expect(by["/blogs/knowledge-base/jams"]).toBeUndefined();
    expect(r.issues[0].status).toBe("broken"); // worst first
  });

  it("applies fixes: replaces or unlinks, saves the old version, and needs publishing", async () => {
    await checkKbLinks(env);
    const out = await applyLinkFixes(env, [
      { articleId: "pick", href: "/products/the-duo-tufting-machine", to: "/products/the-duo" },
      { articleId: "pick", href: "#missing", to: null },
    ], 1);
    expect(out).toEqual({ articles: 1 });
    const a = await one("SELECT body_html FROM kb_articles WHERE id = 'pick'");
    expect(a.body_html).toContain('<a href="/products/the-duo">the Duo</a>');
    expect(a.body_html).toContain(", see this, ");
    expect(a.body_html).not.toContain("#missing");
    expect((await one("SELECT COUNT(*) AS n FROM kb_versions WHERE article_id = 'pick'")).n).toBe(1);
    const left = (await linkReport(env))!.issues.map((i) => i.href);
    expect(left).not.toContain("/products/the-duo-tufting-machine");
    expect(left).not.toContain("#missing");
    await expect(applyLinkFixes(env, [{ articleId: "pick", href: "/pages/old-promo", to: "javascript:alert(1)" }], 1)).rejects.toThrow(/isn't a web address/);
  });

  it("suggests the closest live product only when it's close enough", async () => {
    const index = await loadStoreIndex(env);
    expect(closestProduct(index, "duo", "")).toMatchObject({ handle: "the-duo" });
    expect(closestProduct(index, "ak1-cut-pile", "AK-I")).toBeNull(); // only an archived match
    expect(checkLink(index, "mailto:hi@x.com", "", new Set())).toBeNull();
    expect(checkLink(index, "/collections/all", "", new Set())).toBeNull();
    expect(checkLink(index, "/collections/nope", "", new Set())).toMatchObject({ status: "broken" });
  });
});
