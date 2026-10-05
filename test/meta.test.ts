import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";
import { connectPage, handleWebhook, isNoise, replyOptions, sendSocialReply, ticketThreads, validSignature } from "../src/lib/meta";
import worker from "../src/index";

let env: any;
let calls: { method: string; url: URL; body: any }[];
let graphReply: (method: string, url: URL, body: any) => any;

const sign = async (secret: string, raw: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const one = (sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first();
const all = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).all()).results;

const igComment = (id: string, text: string, from = { id: "u1", username: "jane.tufts" }, media = "m1", parent?: string) =>
  ({ object: "instagram", entry: [{ id: "ig1", time: 1, changes: [{ field: "comments", value: { id, text, from, media: { id: media }, ...(parent ? { parent_id: parent } : {}) } }] }] });
const igDm = (mid: string, text: string, sender = "s1", extra: any = {}) =>
  ({ object: "instagram", entry: [{ id: "ig1", time: 1, messaging: [{ sender: { id: sender }, recipient: { id: "ig1" }, timestamp: Date.now(), message: { mid, text, ...extra } }] }] });

beforeEach(async () => {
  env = { DB: testD1(), SESSION_SECRET: "s".repeat(40), META_APP_ID: "123", META_APP_SECRET: "shh", ANTHROPIC_API_KEY: "" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  calls = [];
  graphReply = (method, url) => {
    const p = url.pathname;
    if (p.endsWith("/m1")) return { caption: "New frame kit drop!", permalink: "https://instagram.com/p/abc", media_url: "https://cdn/m1.jpg", media_type: "IMAGE" };
    if (p.endsWith("/s1")) return { username: "bob.makes", name: "Bob" };
    if (p.endsWith("/replies") || p.endsWith("/comments")) return { id: `reply-${calls.length}` };
    if (p.endsWith("/me/messages")) return { recipient_id: "s9", message_id: `mid-out-${calls.length}` };
    return { success: true };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "cdn.example") return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? "GET", url, body });
    const r = graphReply(init.method ?? "GET", url, body);
    return new Response(JSON.stringify(r), { status: r?.error ? 400 : 200, headers: { "content-type": "application/json" } });
  }));
  await connectPage(env, { id: "page1", name: "Tuft the World", token: "PAGE-TOKEN", igId: "ig1", igUsername: "tufttheworld" }, "https://desk.example");
  calls.length = 0;
});

describe("Instagram & Facebook", () => {
  it("checks Meta's signature and skips emoji-only comments", async () => {
    expect(await validSignature(env, '{"a":1}', await sign("shh", '{"a":1}'))).toBe(true);
    expect(await validSignature(env, '{"a":2}', await sign("shh", '{"a":1}'))).toBe(false);
    expect(await validSignature(env, '{"a":1}', null)).toBe(false);
    for (const t of ["😍🔥", "@amy look!!", "@sam we need this 😍", "Love it ❤️", "wow"]) expect(isNoise(t)).toBe(true);
    for (const t of ["How much is the frame?", "Does this work with acrylic yarn", "ship to canada?", "@tufttheworld is this in stock?"]) expect(isNoise(t)).toBe(false);
  });

  it("connecting subscribes the Page and the app's webhooks for Page and Instagram", async () => {
    await connectPage(env, { id: "page1", name: "Tuft the World", token: "PAGE-TOKEN", igId: "ig1", igUsername: "tufttheworld" }, "https://desk.example");
    expect(calls.map((c) => `${c.method} ${c.url.pathname.replace(/^\/v[\d.]+/, "")} ${c.url.searchParams.get("object") ?? c.url.searchParams.get("subscribed_fields")}`)).toEqual([
      "POST /page1/subscribed_apps feed,messages,message_echoes",
      "POST /123/subscriptions page",
      "POST /123/subscriptions instagram",
    ]);
    expect(calls[1].url.searchParams.get("callback_url")).toBe("https://desk.example/meta/webhook");
    expect(calls[1].url.searchParams.get("access_token")).toBe("123|shh");
  });

  it("turns comments into one ticket per person per post, with the post, and ignores repeats and noise", async () => {
    expect((await handleWebhook(env, igComment("c1", "How big is the frame in this kit?")))[0].ticketId).toBe(1);
    await handleWebhook(env, igComment("c1", "How big is the frame in this kit?")); // Meta retried
    await handleWebhook(env, igComment("c2", "And does it ship to Canada?"));
    expect((await handleWebhook(env, igComment("c3", "😍😍", { id: "u2", username: "amy" })))[0]).toMatchObject({ ticketId: null, skipped: "noise" });
    const t = await one("SELECT * FROM tickets WHERE id = 1");
    expect(t).toMatchObject({ channel: "instagram", customer_email: "instagram:jane.tufts", customer_name: "@jane.tufts", status: "open", unread: 1, message_count: 2, tags: '["Instagram"]' });
    expect(t.subject).toBe("Instagram comment: How big is the frame in this kit?");
    expect(await one("SELECT post_caption, post_url, post_image, last_comment_id FROM social_threads")).toEqual({ post_caption: "New frame kit drop!", post_url: "https://instagram.com/p/abc", post_image: "https://cdn/m1.jpg", last_comment_id: "c2" });
    expect((await all("SELECT external_id FROM messages ORDER BY id")).map((m: any) => m.external_id)).toEqual(["c1", "c2"]);
    expect((await one("SELECT COUNT(*) AS n FROM tickets")).n).toBe(1);
  });

  it("replies publicly, privately (once, continuing as a DM on the same ticket), and by DM within 24 hours", async () => {
    await handleWebhook(env, igComment("c1", "Is my order shipped yet?"));
    const me = { id: 1, name: "Tim" };
    await sendSocialReply(env, 1, me, "Hi! Sending you a DM now.", "public");
    expect(calls.at(-1)!.url.pathname).toMatch(/\/c1\/replies$/);
    expect(calls.at(-1)!.url.searchParams.get("message")).toBe("Hi! Sending you a DM now.");
    // Our reply comes back through the webhook: not added twice
    const ourId = (await one("SELECT external_id FROM messages WHERE direction = 'out'")).external_id;
    await handleWebhook(env, igComment(ourId, "Hi! Sending you a DM now.", { id: "ig1", username: "tufttheworld" }, "m1", "c1"));
    expect((await one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'")).n).toBe(1);

    let opts = replyOptions(await ticketThreads(env, 1), new Set());
    expect(opts).toMatchObject({ public: true, private: true, dm: false });
    await sendSocialReply(env, 1, me, "What's your order number?", "private");
    expect(calls.at(-1)!.body).toEqual({ recipient: { comment_id: "c1" }, message: { text: "What's your order number?" } });
    // Their answer is a DM from the id Meta gave back: same ticket
    await handleWebhook(env, igDm("mid-in-1", "It's #1042", "s9"));
    expect((await one("SELECT COUNT(*) AS n FROM tickets")).n).toBe(1);
    opts = replyOptions(await ticketThreads(env, 1), new Set(["c1"]));
    expect(opts).toMatchObject({ public: true, private: false, dm: true, dmOpen: true });
    await sendSocialReply(env, 1, me, "Thanks — it shipped today!", "dm");
    expect(calls.at(-1)!.body).toEqual({ recipient: { id: "s9" }, messaging_type: "RESPONSE", message: { text: "Thanks — it shipped today!" } });
    const t = await one("SELECT status, assignee_id, unread FROM tickets WHERE id = 1");
    expect(t).toEqual({ status: "in_progress", assignee_id: 1, unread: 0 });
    // After 24 hours Meta won't deliver; the error is worded for a person
    expect(replyOptions(await ticketThreads(env, 1), new Set(), Date.now() + 25 * 3600_000).dmOpen).toBe(false);
    graphReply = () => ({ error: { code: 10, error_subcode: 2018278, message: "outside window" } });
    await expect(sendSocialReply(env, 1, me, "Hello?", "dm")).rejects.toThrow(/more than 24 hours/);
  });

  it("DMs: the sender's name, photos kept, app-sent echoes added, and a closed ticket reopens", async () => {
    await handleWebhook(env, igDm("d1", "Hi! My gun jams", "s1", { attachments: [{ type: "image", payload: { url: "https://cdn.example/p.jpg" } }] }));
    const t = await one("SELECT * FROM tickets WHERE id = 1");
    expect(t).toMatchObject({ customer_email: "instagram:bob.makes", customer_name: "@bob.makes", subject: "Instagram message: Hi! My gun jams" });
    const m = await one("SELECT attachments, kind FROM messages WHERE external_id = 'd1'");
    expect(m.kind).toBe("social");
    expect(JSON.parse(m.attachments)).toEqual([{ id: "s1", filename: "photo.jpeg", mimeType: "image/jpeg" }]);
    // Someone answered in the Instagram app
    await handleWebhook(env, igDm("d2", "Try cleaning the blade", "ig1", { is_echo: true }).entry ? { object: "instagram", entry: [{ id: "ig1", messaging: [{ sender: { id: "ig1" }, recipient: { id: "s1" }, message: { mid: "d2", text: "Try cleaning the blade", is_echo: true } }] }] } : null);
    expect(await one("SELECT direction, from_name FROM messages WHERE external_id = 'd2'")).toEqual({ direction: "out", from_name: "Instagram app" });
    await env.DB.prepare("UPDATE tickets SET status = 'closed'").run();
    await handleWebhook(env, igDm("d3", "Still jamming", "s1"));
    expect((await one("SELECT status FROM tickets WHERE id = 1")).status).toBe("open");
  });

  it("Facebook comments, and the switches in Settings", async () => {
    graphReply = (_m, url) => url.pathname.endsWith("/page1_p1") ? { message: "Class dates are up", permalink_url: "https://fb.com/p1", full_picture: "https://cdn/p1.jpg" } : { success: true };
    const fb = (id: string, from = { id: "f1", name: "Dana Lee" }) => ({ object: "page", entry: [{ id: "page1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: id, post_id: "page1_p1", parent_id: "page1_p1", message: "Is the Saturday class full?", from, created_time: 1700000000 } }] }] });
    await handleWebhook(env, fb("p1_c1"));
    expect(await one("SELECT channel, customer_name, subject FROM tickets")).toEqual({ channel: "facebook", customer_name: "Dana Lee", subject: "Facebook comment: Is the Saturday class full?" });
    await handleWebhook(env, fb("p1_c2", { id: "page1", name: "Tuft the World" })); // our own comment, not under anything we track
    expect((await one("SELECT COUNT(*) AS n FROM tickets")).n).toBe(1);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('social_settings', ?)").bind(JSON.stringify({ fbComments: false })).run();
    expect((await handleWebhook(env, fb("p1_c3", { id: "f2", name: "Sam" })))[0]).toMatchObject({ skipped: "off" });
  });

  it("the webhook address: Meta's check, signed deliveries only", async () => {
    const token = (await one("SELECT value FROM settings WHERE key = 'meta_verify_token'")).value.replace(/"/g, "");
    const ctx = { waitUntil: (p: Promise<unknown>) => p, passThroughOnException: () => {} } as any;
    const ok = await worker.fetch(new Request(`https://desk.example/meta/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`), env, ctx);
    expect(await ok.text()).toBe("42");
    expect((await worker.fetch(new Request("https://desk.example/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"), env, ctx)).status).toBe(403);
    const raw = JSON.stringify(igComment("c1", "Do you sell replacement needles?"));
    expect((await worker.fetch(new Request("https://desk.example/meta/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": "sha256=00" } }), env, ctx)).status).toBe(401);
    const pending: Promise<unknown>[] = [];
    const r = await worker.fetch(new Request("https://desk.example/meta/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": await sign("shh", raw) } }), env, { ...ctx, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    expect(r.status).toBe(200);
    await Promise.all(pending);
    expect((await one("SELECT COUNT(*) AS n FROM tickets WHERE channel = 'instagram'")).n).toBe(1);
  });
});
