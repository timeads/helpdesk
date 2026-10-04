import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const ai = vi.hoisted(() => ({ answer: { reply: "Clean the blade and oil the spring.", handoff: false, reason: "repair question" } as any, calls: [] as any[] }));
vi.mock("../src/lib/ai", () => ({
  aiConfigured: () => true,
  chatAnswer: vi.fn(async (_env: unknown, input: unknown) => { ai.calls.push(input); return ai.answer; }),
}));
const mail = vi.hoisted(() => ({ sent: [] as { raw: string; thread: string | null }[] }));
vi.mock("../src/lib/gmail", () => ({
  getMailbox: async () => ({ email: "support@tufttheworld.com" }),
  sendRaw: vi.fn(async (_env: unknown, raw: string, thread: string | null) => { mail.sent.push({ raw, thread }); return { id: "gm1", threadId: "th1" }; }),
  importMessage: vi.fn(async () => null),
}));
vi.mock("../src/lib/shopify", () => ({
  customerProfile: vi.fn(async (_env: unknown, email: string) => ({
    customer: null,
    orders: email === "jane@example.com" ? [{ name: "#70001-TG", email, createdAt: "2026-10-01", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", cancelledAt: null,
      lineItems: { nodes: [{ quantity: 2, title: "Yarn", variantTitle: "Red" }] }, shippingLines: { nodes: [{ title: "Ground" }] },
      fulfillments: [{ displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: "1ZTRACK", url: "https://ups/1ZTRACK" }] }] }] : [],
  })),
  findOrderByName: vi.fn(async (_env: unknown, ref: string) => ({
    name: `#${ref}`, email: ref === "68762-TG" ? "jane@example.com" : "someone@else.com", createdAt: "2026-09-30", displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED", cancelledAt: null, lineItems: { nodes: [{ quantity: 1, title: "AK-I", variantTitle: null }] },
    shippingLines: { nodes: [{ title: "Ground" }] }, fulfillments: [{ displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: "1Z1", url: "u" }] }],
  })),
}));

import { agentChatReply, chatMessages, checkVerifyCode, hoursText, proveEmail, rotateIdentitySecret, signedEmail, isOpen, loadChat, moveChatToEmail, respond, startChat, sweepChats, DEFAULT_CHAT } from "../src/lib/chat";

/** The raw email's headers plus its plain-text body, decoded. */
const decode = (raw: string) => {
  const mime = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  const b64 = mime.match(/text\/plain[^\n]*\r\n[^\n]*\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/)?.[1] ?? "";
  return mime + "\n" + new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (ch) => ch.charCodeAt(0)));
};
let env: any;
async function settings(over: object) {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('chat', ?)").bind(JSON.stringify({ ...DEFAULT_CHAT, enabled: true, ...over })).run();
}
const ALWAYS = Array.from({ length: 7 }, () => ({ on: true, start: "00:00", end: "23:59" }));
const NEVER = Array.from({ length: 7 }, () => ({ on: false, start: "09:00", end: "17:00" }));
const ticket = (id: number) => env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
const msgs = (id: number) => env.DB.prepare("SELECT kind, direction, body_text FROM messages WHERE ticket_id = ? ORDER BY id").bind(id).all().then((r: any) => r.results);

beforeEach(() => {
  env = { DB: testD1(), APP_NAME: "Tuft the World Support" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@tufttheworld.com', 'Tim Eads')").run();
  ai.calls.length = 0;
  mail.sent.length = 0;
  ai.answer = { reply: "Clean the blade and oil the spring.", handoff: false, reason: "repair question" };
});

describe("office hours", () => {
  it("knows when the team is in (Eastern time) and says so", () => {
    const s = DEFAULT_CHAT;
    expect(isOpen(s, new Date("2026-10-05T14:00:00Z"))).toBe(true); // Mon 10am ET
    expect(isOpen(s, new Date("2026-10-05T22:00:00Z"))).toBe(false); // Mon 6pm ET
    expect(isOpen(s, new Date("2026-10-04T15:00:00Z"))).toBe(false); // Sunday
    expect(hoursText(s)).toBe("Mon–Fri 9am–5pm Eastern");
  });
});

describe("website chat", () => {
  it("starts a chat as a ticket tagged Chat", async () => {
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "My gun keeps jamming\nhelp", ipHash: "x" });
    const t = await ticket(chat.ticket_id);
    expect(t).toMatchObject({ channel: "chat", subject: "Chat: My gun keeps jamming", customer_email: "jane@example.com", status: "open", unread: 1 });
    expect(JSON.parse(t.tags)).toEqual(["Chat"]);
    expect(await msgs(chat.ticket_id)).toEqual([{ kind: "chat", direction: "in", body_text: "My gun keeps jamming\nhelp" }]);
  });

  it("draft mode: the AI drafts for a teammate and the customer is told someone's coming", async () => {
    await settings({ aiMode: "draft", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "My gun jams", ipHash: "x" });
    await respond(env, chat.id);
    const c = await loadChat(env, chat.id);
    expect(c!.state).toBe("waiting");
    expect(JSON.parse(c!.ai_draft!).reply).toBe("Clean the blade and oil the spring.");
    const m = await msgs(chat.ticket_id);
    expect(m.map((x: any) => x.kind)).toEqual(["chat", "chat_system"]);
    expect(m.some((x: any) => x.kind === "chat_ai")).toBe(false);
  });

  it("auto mode: the AI answers, and the ticket waits on the customer", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "My gun jams", ipHash: "x" });
    await respond(env, chat.id);
    expect((await msgs(chat.ticket_id)).at(-1)).toEqual({ kind: "chat_ai", direction: "out", body_text: "Clean the blade and oil the spring." });
    expect((await ticket(chat.ticket_id)).status).toBe("in_progress");
    expect((await loadChat(env, chat.id))!.ai_replies).toBe(1);
  });

  it("auto mode: article and product cards are kept with the answer, shown to the widget, and listed in emailed transcripts", async () => {
    await settings({ aiMode: "auto", hours: NEVER });
    const cards = {
      articles: [{ title: "Fixing a jammed gun", url: "https://tufttheworld.com/blogs/knowledge-base/jams", image: null }],
      products: [{ title: "Tufting Starter Kit", url: "https://tufttheworld.com/products/kit", price: "$299", image: null, why: "Everything to start." }],
    };
    ai.answer = { reply: "It's usually the blade.\n1. Unplug the gun. Then open the front.\n2. Clean the blade.", handoff: true, reason: "wants a person", cards };
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "My gun jams", ipHash: "x" });
    await respond(env, chat.id);
    const shown = await chatMessages(env, chat);
    const answer = shown.find((m) => m.from === "ai")!;
    expect(answer.cards).toEqual(cards);
    expect(shown.find((m) => m.from === "visitor")!.cards).toBeNull();
    const email = decode(mail.sent[0].raw);
    expect(email).toContain("Read more:");
    expect(email).toContain("Fixing a jammed gun: https://tufttheworld.com/blogs/knowledge-base/jams");
    expect(email).toContain("Tufting Starter Kit ($299): https://tufttheworld.com/products/kit");
  });

  it("draft mode: a teammate's draft carries the links as text", async () => {
    await settings({ aiMode: "draft", hours: ALWAYS });
    ai.answer = { reply: "Try cleaning the blade.", handoff: false, reason: "repair", cards: { articles: [{ title: "Jams", url: "https://x/jams", image: null }], products: [] } };
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "My gun jams", ipHash: "x" });
    await respond(env, chat.id);
    const draft = JSON.parse((await loadChat(env, chat.id))!.ai_draft!);
    expect(draft.reply).toBe("Try cleaning the blade.\n\nRead more:\n• Jams: https://x/jams");
    expect(draft.cards).toBeUndefined();
  });

  it("trusts a logged-in customer's email when the theme signed it, so orders need no code", async () => {
    const id = async (email: string, ts: number, secret: string) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${email}|${ts}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { email, ts, sig };
    };
    const now = Math.floor(Date.now() / 1000);
    expect(await signedEmail(env, await id("jane@example.com", now, "anything"))).toBeNull(); // no secret set up yet
    const { secret } = await rotateIdentitySecret(env);
    const good = await id("jane@example.com", now, secret);
    expect(await signedEmail(env, { ...good, email: "Jane@Example.com" })).toBe("jane@example.com"); // Liquid downcases; so do we
    expect(await signedEmail(env, await id("jane@example.com", now - 13 * 3600, secret))).toBeNull(); // too old
    expect(await signedEmail(env, { ...good, email: "someone@else.com" })).toBeNull(); // signature is for Jane
    expect(await signedEmail(env, await id("jane@example.com", now, "wrong-secret"))).toBeNull();
    expect(await signedEmail(env, { email: "jane@example.com", ts: now, sig: "zz" })).toBeNull();

    await settings({ aiMode: "auto", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "Where's my order?", ipHash: "x" });
    await proveEmail(env, chat, (await signedEmail(env, good))!);
    await respond(env, chat.id);
    expect(ai.calls[0].verifiedEmails).toEqual(["jane@example.com"]);
    expect(ai.calls[0].orders.map((o: any) => o.name)).toEqual(["#70001-TG"]); // their orders, no code asked
  });

  it("only shares an order when its email matches the chat's", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "Where is #68762-TG? Also #55555-TG", ipHash: "x" });
    await respond(env, chat.id);
    expect(ai.calls[0].orders).toHaveLength(1);
    expect(ai.calls[0].orders[0].name).toBe("#68762-TG");
    expect(ai.calls[0].mismatched).toEqual(["#55555-TG"]);
  });

  it("auto mode handoff after hours moves the chat to email with the transcript", async () => {
    await settings({ aiMode: "auto", hours: NEVER });
    ai.answer = { reply: "I'll get a teammate to look at that.", handoff: true, reason: "wants a refund" };
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "I want a refund", ipHash: "x" });
    await respond(env, chat.id);
    expect((await loadChat(env, chat.id))!.state).toBe("email");
    expect(mail.sent).toHaveLength(1);
    const email = decode(mail.sent[0].raw);
    expect(email).toContain("To: jane@example.com");
    expect(email).toContain("Your chat with Tuft the World");
    const t = await ticket(chat.ticket_id);
    expect(t).toMatchObject({ status: "open", gmail_thread_id: "th1" });
    expect((await msgs(chat.ticket_id)).at(-1).body_text).toMatch(/moved this conversation to email/);
  });

  it("a teammate's reply goes to the chat while the customer is there, by email once they've left", async () => {
    await settings({ aiMode: "draft", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "Hello?", ipHash: "x" });
    expect((await agentChatReply(env, chat, { id: 1, name: "Tim Eads" }, "Hi Jane, Tim here!")).via).toBe("chat");
    const live = await loadChat(env, chat.id);
    expect(live!.state).toBe("agent");
    expect((await msgs(chat.ticket_id)).at(-1)).toEqual({ kind: "chat", direction: "out", body_text: "Hi Jane, Tim here!" });

    await env.DB.prepare("UPDATE chats SET visitor_seen_at = ? WHERE id = ?").bind(new Date(Date.now() - 5 * 60_000).toISOString(), chat.id).run();
    const gone = await loadChat(env, chat.id);
    expect((await agentChatReply(env, gone!, { id: 1, name: "Tim Eads" }, "Following up: here's the fix.")).via).toBe("email");
    expect(decode(mail.sent[0].raw)).toContain("Following up: here's the fix.");
  });

  it("moves a waiting chat to email when nobody picks it up in time", async () => {
    await settings({ aiMode: "off", hours: ALWAYS, handoffMinutes: 3 });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "Anyone there?", ipHash: "x" });
    await respond(env, chat.id);
    expect((await loadChat(env, chat.id))!.state).toBe("waiting");
    await sweepChats(env);
    expect((await loadChat(env, chat.id))!.state).toBe("waiting"); // not yet
    await env.DB.prepare("UPDATE chats SET waiting_since = ? WHERE id = ?").bind(new Date(Date.now() - 4 * 60_000).toISOString(), chat.id).run();
    await sweepChats(env);
    expect((await loadChat(env, chat.id))!.state).toBe("email");
  });

  it("closes a chat the AI fully answered once the visitor leaves", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "What yarn for a rug?", ipHash: "x" });
    await respond(env, chat.id);
    await env.DB.prepare("UPDATE chats SET visitor_seen_at = ? WHERE id = ?").bind(new Date(Date.now() - 40 * 60_000).toISOString(), chat.id).run();
    await sweepChats(env);
    expect((await loadChat(env, chat.id))!.state).toBe("ended");
    expect((await ticket(chat.ticket_id)).status).toBe("closed");
    expect(mail.sent).toHaveLength(0);
  });

  it("the customer can ask to continue by email", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    const chat = await startChat(env, { name: "", email: "jane@example.com", message: "photos coming", ipHash: "x" });
    await moveChatToEmail(env, chat, { reason: "The customer asked to continue by email" });
    expect((await loadChat(env, chat.id))!.state).toBe("email");
    expect(decode(mail.sent[0].raw)).toContain("photos coming");
  });

  it("looks up orders by email after the customer types the code we emailed", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    ai.answer = { reply: "I can look that up — I've emailed you a 6-digit code.", handoff: false, reason: "tracking", verify_email: "jane@example.com" };
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "Where's my order? I don't have the number", ipHash: "x" });
    await respond(env, chat.id);
    expect(mail.sent).toHaveLength(1);
    const email = decode(mail.sent[0].raw);
    const code = email.match(/Your chat code: (\d{6})/)![1];
    expect(email).toContain("To: jane@example.com");
    expect((await msgs(chat.ticket_id)).map((m: any) => m.kind)).toEqual(["chat", "chat_ai", "chat_system"]);
    expect((await msgs(chat.ticket_id)).at(-1).body_text).toMatch(/emailed a 6-digit code to j•+@example\.com/);

    // Not a code → handled normally; a wrong code → refused
    expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, "thanks!")).toBeNull();
    const wrong = code === "000000" ? "111111" : "000000";
    expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, wrong)).toBe("bad");

    // The right code proves the email; now the AI sees every recent order for it
    expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe("ok");
    expect(JSON.parse((await loadChat(env, chat.id))!.verified_emails!)).toEqual(["jane@example.com"]);
    ai.answer = { reply: "Your order #70001-TG is on its way.", handoff: false, reason: "", verify_email: "" };
    await respond(env, chat.id);
    const last = ai.calls.at(-1);
    expect(last.verifiedEmails).toEqual(["jane@example.com"]);
    expect(last.orders[0]).toMatchObject({ name: "#70001-TG", tracking: [{ number: "1ZTRACK" }] });
    expect(JSON.stringify(last.orders)).not.toMatch(/address|Philadelphia/);
  });

  it("locks the code after five wrong tries and caps how many codes one chat can send", async () => {
    await settings({ aiMode: "auto", hours: ALWAYS });
    ai.answer = { reply: "Code sent.", handoff: false, reason: "", verify_email: "jane@example.com" };
    const chat = await startChat(env, { name: "Jane", email: "jane@example.com", message: "track my order", ipHash: "x" });
    await respond(env, chat.id);
    const code = decode(mail.sent[0].raw).match(/Your chat code: (\d{6})/)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, wrong)).toBe("bad");
    expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, wrong)).toBe("locked");
    expect(await checkVerifyCode(env, (await loadChat(env, chat.id))!, code)).toBeNull(); // no code pending any more
    await respond(env, chat.id);
    await respond(env, chat.id);
    await respond(env, chat.id);
    expect(mail.sent).toHaveLength(3); // at most 3 codes per chat
  });
});
