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
  findOrderByName: vi.fn(async (_env: unknown, ref: string) => ({
    name: `#${ref}`, email: ref === "68762-TG" ? "jane@example.com" : "someone@else.com", createdAt: "2026-09-30", displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED", cancelledAt: null, lineItems: { nodes: [{ quantity: 1, title: "AK-I", variantTitle: null }] },
    shippingLines: { nodes: [{ title: "Ground" }] }, fulfillments: [{ displayStatus: "IN_TRANSIT", trackingInfo: [{ company: "UPS", number: "1Z1", url: "u" }] }],
  })),
}));

import { agentChatReply, hoursText, isOpen, loadChat, moveChatToEmail, respond, startChat, sweepChats, DEFAULT_CHAT } from "../src/lib/chat";

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
});
