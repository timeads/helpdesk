import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

// The two AI steps: pick sources, then answer
const ai = vi.hoisted(() => ({ pick: { kind: "fix", source_ids: [] as string[] } as any, answer: {} as any, calls: [] as string[] }));
vi.mock("../src/lib/manual", () => ({
  ask: vi.fn(async (_env: unknown, content: { text: string }[], schema: any) => {
    ai.calls.push(content[0].text);
    return schema.properties.source_ids ? ai.pick : ai.answer;
  }),
}));
vi.mock("../src/lib/shopify", () => ({
  shopify: vi.fn(async () => ({
    products: {
      nodes: [
        { id: "gid://shopify/Product/11", title: "Tufting Starter Kit", handle: "kit", productType: "Kits", onlineStoreUrl: "https://tufttheworld.com/products/kit", description: "Frame, machine and cloth.",
          featuredMedia: { preview: { image: { url: "https://cdn/kit.jpg" } } }, priceRangeV2: { minVariantPrice: { amount: "299.0", currencyCode: "USD" }, maxVariantPrice: { amount: "299.0" } }, variants: { nodes: [{ title: "Default Title", availableForSale: true }] } },
        { id: "gid://shopify/Product/12", title: "Sold out thing", handle: "gone", productType: "", onlineStoreUrl: "https://tufttheworld.com/products/gone", description: "",
          featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: "10", currencyCode: "USD" }, maxVariantPrice: { amount: "10" } }, variants: { nodes: [{ title: "Default Title", availableForSale: false }] } },
        { id: "gid://shopify/Product/13", title: "One Day Tufting workshop", handle: "one-day", productType: "Workshop", onlineStoreUrl: "https://tufttheworld.com/products/one-day", description: "Make a rug in a day.",
          featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: "150", currencyCode: "USD" }, maxVariantPrice: { amount: "150" } }, variants: { nodes: [{ title: "Default Title", availableForSale: true }] } },
      ],
      pageInfo: { hasNextPage: false, endCursor: "" },
    },
  })),
}));

import { askClasses, askProducts, handleAsk, shapeAnswer, type Source } from "../src/lib/ask";
import { asksAboutStock, stockText } from "../src/lib/stock";
import { importKb } from "../src/lib/kb";

let env: any;
const blank = { answer: "", steps: [], cite_ids: [], products: [], classes: [], ask_back: "", handoff: false };

beforeEach(async () => {
  env = { DB: testD1(), ANTHROPIC_API_KEY: "k" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  await importKb(env, {
    topics: [{ id: "troubleshoot", name: "Machine Troubleshooting" }],
    articles: [{ id: "skipping", topic_id: "troubleshoot", title: "Machine skipping stitches", html: "<p>Check the needle depth.</p><img src=\"/kb/img/3\">" }],
  }, 1);
  await env.DB.prepare("UPDATE kb_articles SET shopify_handle = 'skipping', synced_at = updated_at").run();
  env.DB.raw.prepare("INSERT INTO manual_topics (id, title, product, summary, body, status) VALUES (7, 'Dull blade', 'AK-I', 'Blade wear', 'Swap the blade (our supplier is X).', 'published')").run();
  ai.calls.length = 0;
  ai.pick = { kind: "fix", source_ids: ["a:skipping", "r:7", "a:made-up"] };
  ai.answer = { ...blank, answer: "Usually the needle depth.", steps: [{ text: "Set the depth.", source_ids: ["a:skipping"] }, { text: "Swap a dull blade.", source_ids: ["r:7"] }], cite_ids: ["a:skipping", "r:7"] };
});

describe("the learn hub Ask box", () => {
  it("answers from the sources it picked, links only public articles, and uses internal notes without showing them", async () => {
    const r = await handleAsk(env, "https://desk.example", { question: "My AK-I keeps skipping", machine: "AK-I (cut pile)", ipHash: "ip1" });
    expect(ai.calls[0]).toContain("a:skipping [article] Machine skipping stitches");
    expect(ai.calls[0]).toContain("r:7 [repair] Dull blade (AK-I)");
    expect(ai.calls[1]).toContain("Swap the blade"); // the repair note's text reaches the AI…
    expect(r).toMatchObject({ kind: "fix", answer: "Usually the needle depth.", handoff: false });
    expect(r.steps).toEqual([{ text: "Set the depth.", refs: [1] }, { text: "Swap a dull blade.", refs: [] }]); // …but is never linked
    expect(r.articles).toEqual([{ n: 1, title: "Machine skipping stitches", url: "https://tufttheworld.com/blogs/knowledge-base/skipping", image: "https://desk.example/kb/img/3" }]);
    const log = await env.DB.prepare("SELECT * FROM ask_log").first();
    expect(log).toMatchObject({ question: "My AK-I keeps skipping", machine: "AK-I (cut pile)", kind: "fix" });
    expect(JSON.parse(log.sources)).toEqual(["a:skipping", "r:7"]);
  });

  it("reuses a recent answer to the same question, and limits each visitor per hour", async () => {
    await handleAsk(env, "o", { question: "Skipping stitches?", machine: "", ipHash: "ip1" });
    await handleAsk(env, "o", { question: "skipping  stitches", machine: "", ipHash: "ip2" });
    expect(ai.calls).toHaveLength(2); // one question = two AI steps; the repeat cost nothing
    for (let i = 0; i < 14; i++) await handleAsk(env, "o", { question: "skipping stitches", machine: "", ipHash: "ip1" });
    await expect(handleAsk(env, "o", { question: "skipping stitches", machine: "", ipHash: "ip1" })).rejects.toThrow(/last hour/);
  });

  it("recommends only real, in-stock products and sends order questions to a person", async () => {
    const chosen: Source[] = [];
    const products = await askProducts(env);
    expect(products.map((p) => [p.handle, p.available])).toEqual([["kit", true], ["gone", false], ["one-day", true]]); // sold out kept, marked
    const buy = shapeAnswer("buy", { ...blank, answer: "Start with the kit.", products: [{ handle: "kit", why: "Everything to start." }, { handle: "invented", why: "x" }, { handle: "gone", why: "sold out" }] }, chosen, products, []);
    expect(buy.products).toEqual([{ title: "Tufting Starter Kit", url: "https://tufttheworld.com/products/kit", price: "$299", image: "https://cdn/kit.jpg", why: "Everything to start." }]);
    expect(shapeAnswer("order", { ...blank, answer: "We can look that up." }, chosen, [], []).handoff).toBe(true);
  });

  it("answers restock questions from TuftStock's incoming orders, with sold-out items from the store", async () => {
    env.TUFTSTOCK_URL = "https://stock.example/";
    env.TUFTSTOCK_TOKEN = "t".repeat(30);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      expect(url).toBe("https://stock.example/api/incoming");
      expect(init.headers.authorization).toBe(`Bearer ${"t".repeat(30)}`);
      return new Response(JSON.stringify({ items: [
        { shopifyVariantId: "v1", shopifyProductId: "12", title: "Sold out thing", option: null, sku: "S1", onHand: 0, incoming: 40, stage: "shipped", expected: "2026-10-09", late: false },
      ] }), { status: 200 });
    }));
    ai.pick = { kind: "stock", source_ids: [] };
    ai.answer = { ...blank, answer: "It's on its way — expected around October 9." };
    const r = await handleAsk(env, "o", { question: "When is the sold out thing back in stock?", machine: "", ipHash: "ip9" });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ kind: "stock", answer: "It's on its way — expected around October 9." });
    expect(ai.calls[1]).toContain("gone | Sold out thing |  | $10 | SOLD OUT");
    expect(ai.calls[1]).toContain("Sold out on the store right now:\n- Sold out thing (sold out)");
    expect(ai.calls[1]).toContain("- Sold out thing: out of stock; 40 more shipped, on its way, expected at our studio around October 9");
    expect(ai.calls[1]).not.toMatch(/supplier name|unit cost/i);
  });

  it("words restock stages for customers and spots availability questions", () => {
    const row = { shopifyVariantId: "v", shopifyProductId: "p", title: "Reflect Wool Yarn", option: "Orange", sku: null, onHand: 0, incoming: 36 };
    expect(stockText([{ ...row, stage: "ordered", expected: "2026-09-30", late: true }], [])).toContain("Reflect Wool Yarn — Orange: out of stock; 36 more ordered, running behind (was due September 30; no firm new date)");
    expect(stockText([{ ...row, stage: "arrived", expected: null, late: false }], [])).toContain("arrived at our studio, being checked in");
    expect(stockText([], [{ title: "Reflect Wool Yarn", options: ["Orange", "Teal"] }])).toContain("- Reflect Wool Yarn (sold out: Orange, Teal)");
    expect(stockText([], [])).toBe("");
    expect(asksAboutStock("When will the orange wool be back in stock?")).toBe(true);
    expect(asksAboutStock("is the duo available")).toBe(true);
    expect(asksAboutStock("my machine keeps skipping")).toBe(false);
  });

  it("reads upcoming class dates and open seats from the booking app", async () => {
    env.BOOKING_SUPABASE_URL = "https://book.supabase.co";
    env.BOOKING_SUPABASE_ANON_KEY = "anon";
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      seen.push(url);
      expect(init.headers.apikey).toBe("anon");
      const body = url.includes("/workshops?")
        ? [{ id: "w1", title: "One Day Tufting", description: null, shopify_product_id: "13", duration_minutes: 360, location: "Bok Building", price_display: "$150" }]
        : [{ workshop_id: "w1", starts_at: "2026-10-10T14:00:00Z", capacity: 8, seats_booked: 6 }, { workshop_id: "w1", starts_at: "2026-10-17T14:00:00Z", capacity: 8, seats_booked: 8 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const classes = await askClasses(env, await askProducts(env));
    vi.unstubAllGlobals();
    expect(seen[1]).toContain("widget_sessions?status=eq.scheduled&bookings_closed=eq.false");
    expect(classes).toEqual([{ title: "One Day Tufting", url: "https://tufttheworld.com/products/one-day", price: "$150", duration: "6 hours", location: "Bok Building",
      about: "Make a rug in a day.", dates: [{ when: "Sat, Oct 10, 10:00 AM ET", seatsLeft: 2 }] }]); // the full class is left out
    const shown = shapeAnswer("classes", { ...blank, answer: "Try the one-day class.", classes: [{ title: "one day tufting", why: "Make a full rug." }] }, [], [], classes);
    expect(shown.classes).toEqual([{ title: "One Day Tufting", url: "https://tufttheworld.com/products/one-day", price: "$150", why: "Make a full rug.", dates: ["Sat, Oct 10, 10:00 AM ET · 2 left"] }]);
  });
});
