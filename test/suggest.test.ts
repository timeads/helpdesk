import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const ai = vi.hoisted(() => ({ calls: [] as string[], pick: { kind: "fix", source_ids: ["a:jams", "r:1"] } as any, options: [] as any[], fail: false }));
vi.mock("../src/lib/manual", () => ({
  ask: vi.fn(async (_env: unknown, content: { text: string }[], schema: any) => {
    ai.calls.push(content[0].text);
    if (schema.properties.source_ids) return ai.pick;
    if (ai.fail) throw new Error("AI error: overloaded");
    return { options: ai.options };
  }),
}));
vi.mock("../src/lib/shopify", () => ({
  shopifyConfigured: () => true,
  customerProfile: vi.fn(async () => ({ customer: { displayName: "Jane Doe" }, orders: [{
    name: "#70001-TG", createdAt: "2026-10-01", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: "299.00", currencyCode: "USD" } }, lineItems: { nodes: [{ quantity: 1, title: "The Duo", variantTitle: null }] },
    shippingLines: { nodes: [{ title: "Ground" }] }, fulfillments: [{ displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: "1Z9", url: "https://ups/1Z9" }] }],
  }] })),
  shopify: vi.fn(async () => ({ products: { nodes: [], pageInfo: { hasNextPage: false } } })),
}));

import { importKb } from "../src/lib/kb";
import { suggestReplies, suggestTick, ticketSuggestion } from "../src/lib/suggest";

let env: any;
const now = () => new Date().toISOString();
const ticket = (id: number, from: string, status = "open", channel = "email") => {
  env.DB.raw.prepare("INSERT INTO tickets (id, subject, customer_email, customer_name, status, created_at, last_message_at, channel) VALUES (?, 'My Duo jams', ?, 'Jane', ?, ?, ?, ?)").run(id, from, status, now(), now(), channel);
  env.DB.raw.prepare("INSERT INTO messages (ticket_id, direction, from_email, sent_at, body_text) VALUES (?, 'in', ?, ?, 'The yarn keeps jamming in my Duo. Also where is my order?')").run(id, from, now());
};

beforeEach(async () => {
  env = { DB: testD1(), ANTHROPIC_API_KEY: "k" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  await importKb(env, { topics: [{ id: "t", name: "Troubleshooting" }], articles: [{ id: "jams", topic_id: "t", title: "Fixing jams", html: "<p>Check the needle depth.</p>" }] }, 1);
  await env.DB.prepare("UPDATE kb_articles SET shopify_handle = 'fixing-jams', synced_at = updated_at").run();
  env.DB.raw.prepare("INSERT INTO manual_topics (id, title, product, summary, body, status) VALUES (1, 'Duo jams', 'Duo', 'Jams', 'Our supplier notes: swap the looper.', 'published')").run();
  ai.calls.length = 0;
  ai.fail = false;
  ai.options = [
    { label: "Fix steps", body: "Hi Jane,\n\n1. Check the needle depth.\n2. Re-thread.\n\nYour order #70001-TG is on its way (UPS 1Z9).", article_ids: ["a:jams", "r:1", "a:made-up"], product_handles: ["nope"] },
    { label: "Ask for a video", body: "Hi Jane, could you send a short video of it jamming?", article_ids: [], product_handles: [] },
  ];
});

describe("suggested replies for email tickets", () => {
  it("writes options from the knowledge base and the customer's orders, linking only public guides", async () => {
    ticket(5, "jane@example.com");
    const s = await suggestReplies(env, 5, "Tim");
    expect(s).toMatchObject({ status: "ready", used: null });
    expect(s!.options).toHaveLength(2);
    expect(s!.options[0]).toEqual({ label: "Fix steps", body: expect.stringContaining("Helpful guides:\n• Fixing jams: https://tufttheworld.com/blogs/knowledge-base/fixing-jams") });
    expect(s!.options[0].body).not.toContain("Duo jams"); // internal repair note: used, never linked
    expect(s!.options[0].body).not.toContain("Products:"); // unknown product dropped
    const prompt = ai.calls[1];
    expect(prompt).toContain('"#70001-TG"'); // their orders
    expect(prompt).toContain("swap the looper"); // repair note content reaches the AI
    expect(prompt).toContain("You're writing as Tim");
  });

  it("the minute job does new customer emails on open tickets only, once per email", async () => {
    ticket(1, "jane@example.com");
    ticket(2, "noreply@shopify.com");
    ticket(3, "bob@example.com", "closed");
    ticket(4, "amy@example.com", "open", "chat");
    expect(await suggestTick(env)).toEqual({ made: 1 });
    expect((await ticketSuggestion(env, 1))!.status).toBe("ready");
    for (const id of [2, 3, 4]) expect(await ticketSuggestion(env, id)).toBeNull();
    expect(await suggestTick(env)).toEqual({ made: 0 }); // already done for this email
    // A new email from the customer gets fresh suggestions
    env.DB.raw.prepare("INSERT INTO messages (ticket_id, direction, from_email, sent_at, body_text) VALUES (1, 'in', 'jane@example.com', ?, 'Any update?')").run(new Date(Date.now() + 1000).toISOString());
    expect(await suggestTick(env)).toEqual({ made: 1 });
  });

  it("can be turned off, and records failures so a teammate can retry", async () => {
    ticket(1, "jane@example.com");
    env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('ai_suggest', 'false')").run();
    expect(await suggestTick(env)).toEqual({ made: 0 });
    ai.fail = true;
    const s = await suggestReplies(env, 1);
    expect(s).toMatchObject({ status: "error", error: "AI error: overloaded", options: [] });
  });
});
