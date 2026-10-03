import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async (_env: unknown, query: string, vars: any) => {
    if (query.includes("SiteSources")) return { shop: { shopPolicies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>30 days</p>", url: "https://tufttheworld.com/policies/refund-policy" }, { type: "CONTACT_INFORMATION", title: "Contact", body: "" }] }, pages: { nodes: [{ id: "gid://shopify/Page/1", title: "Warranty", handle: "warranty", isPublished: true, bodySummary: "1 year" }] } };
    if (query.includes("SitePolicies")) return { shop: { shopPolicies: [{ type: "REFUND_POLICY", title: "Refund policy", body: "<p>Returns within <b>30 days</b>.</p>", url: "https://tufttheworld.com/policies/refund-policy" }] } };
    if (query.includes("SitePages")) return { nodes: vars.ids.map((id: string) => ({ id, title: "Warranty", handle: "warranty", body: "<h2>Warranty</h2><p>Machines have a 1-year warranty.</p>" })) };
    throw new Error(query);
  }),
}));
import { addSources, dailyRefresh, readUrl, siteSources } from "../src/lib/site-knowledge";

let env: any;
beforeEach(() => { env = { DB: testD1() }; });
afterEach(() => vi.unstubAllGlobals());
const rows = () => env.DB.prepare("SELECT name, content, type, source, source_url FROM knowledge ORDER BY id").all().then((r: any) => r.results);

describe("AI knowledge from the website", () => {
  it("lists store policies and pages, and adds them as entries that refresh in place", async () => {
    const s = await siteSources(env);
    expect(s.policies.map((p) => p.source)).toEqual(["policy:REFUND_POLICY"]); // empty policies are skipped
    expect(s.pages[0]).toMatchObject({ source: "page:gid://shopify/Page/1", url: "https://tufttheworld.com/pages/warranty", added: false });
    expect(await addSources(env, ["policy:REFUND_POLICY", "page:gid://shopify/Page/1"])).toEqual({ added: 2 });
    expect(await rows()).toEqual([
      { name: "Refund policy", content: "Returns within 30 days.", type: "policy", source: "policy:REFUND_POLICY", source_url: "https://tufttheworld.com/policies/refund-policy" },
      { name: "Warranty", content: "Warranty\nMachines have a 1-year warranty.", type: "policy", source: "page:gid://shopify/Page/1", source_url: "https://tufttheworld.com/pages/warranty" },
    ]);
    await addSources(env, ["policy:REFUND_POLICY"]); // again: updated, not duplicated
    expect(await rows()).toHaveLength(2);
    expect((await siteSources(env)).pages[0].added).toBe(true);
  });

  it("reads any public page by link, keeping the main content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html><head><title>Shipping info – Tuft the World</title></head><body><nav>Menu Shop</nav><main><h1>Shipping</h1><p>We ship within 2 business days from Philadelphia.</p></main><footer>© 2026</footer></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } })));
    const r = await readUrl("https://tufttheworld.com/pages/shipping");
    expect(r.title).toBe("Shipping info");
    expect(r.text).toBe("Shipping\nWe ship within 2 business days from Philadelphia.");
    await expect(readUrl("http://localhost/x")).rejects.toThrow(/public/);
  });

  it("refreshes once a day from the cron", async () => {
    await addSources(env, ["policy:REFUND_POLICY"]);
    await env.DB.prepare("UPDATE knowledge SET content = 'stale'").run();
    await dailyRefresh(env);
    expect((await rows())[0].content).toBe("Returns within 30 days.");
    await env.DB.prepare("UPDATE knowledge SET content = 'stale'").run();
    await dailyRefresh(env); // already ran today
    expect((await rows())[0].content).toBe("stale");
  });
});
