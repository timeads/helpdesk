import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

vi.mock("../src/lib/gmail", () => ({ getAttachment: vi.fn(async () => "iVBORw0KGgo-_") }));
import { pendingCount, scanBatch, manualKnowledge } from "../src/lib/manual";

const PHOTO = { id: "att1", filename: "jam.jpg", mimeType: "image/jpeg", size: 1000 };
const VIDEO = { id: "att2", filename: "noise.mp4", mimeType: "video/mp4", size: 5_000_000 };

function seed(db: ReturnType<typeof testD1>) {
  const r = db.raw;
  const ticket = (id: number, subject: string, tags = "[]", status = "closed") =>
    r.prepare("INSERT INTO tickets (id, subject, customer_email, customer_name, status, created_at, last_message_at, closed_at, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, subject, `c${id}@example.com`, `Customer ${id}`, status, "2026-09-0" + id + "T10:00:00Z", "2026-09-0" + id + "T12:00:00Z", "2026-09-0" + id + "T12:00:00Z", tags);
  const msg = (ticketId: number, dir: string, body: string, atts: unknown[] = []) =>
    r.prepare("INSERT INTO messages (ticket_id, gmail_message_id, direction, from_email, sent_at, body_text, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ticketId, `g${ticketId}${dir}${Math.random()}`, dir, dir === "in" ? `c${ticketId}@example.com` : "support@x.com", "2026-09-01T10:00:00Z", body, JSON.stringify(atts));
  ticket(1, "My AK-I gun keeps jamming", '["Repairs"]');
  msg(1, "in", "It jams after a few stitches, photo attached", [PHOTO, VIDEO]);
  msg(1, "out", "Clean the lint from the blade and oil the spring.");
  ticket(2, "Where is my order?");
  msg(2, "in", "Where is my order, it's broken? no wait, just late");
  msg(2, "out", "It ships tomorrow.");
  ticket(3, "Gun not cutting", "[]", "open"); // still open: not read yet
  msg(3, "in", "My gun is not cutting");
  msg(3, "out", "Try a new blade");
}

/** A streamed Messages API reply (server-sent events), as the SDK's stream() reads it. */
const aiReply = (obj: unknown, stop = "end_turn") => {
  const text = JSON.stringify(obj);
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const sse = [
    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    ev("content_block_stop", { index: 0 }),
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }),
    ev("message_stop", {}),
  ].join("");
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
};

describe("repair manual scan", () => {
  let db: ReturnType<typeof testD1>;
  let env: any;
  const calls: any[] = [];
  beforeEach(() => {
    db = testD1();
    seed(db);
    env = { DB: db, ANTHROPIC_API_KEY: "test", AI_MODEL: "claude-opus-5-5" };
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const text = body.messages[0].content.map((b: any) => b.text ?? "").join("");
      if (text.includes("decide whether it's a repair")) {
        return aiReply({
          tickets: [
            { ticket_id: 1, is_repair: true, topic: "new:jam", case_summary: "AK-I jammed; cleaned blade and oiled spring", outcome: "Fixed by cleaning", media: [{ ref: "t1m1a0", caption: "Lint around the blade" }, { ref: "t1m1a1", caption: "Grinding noise" }, { ref: "bogus", caption: "x" }] },
            { ticket_id: 2, is_repair: false, topic: "", case_summary: "", outcome: "", media: [] },
          ],
          new_topics: [{ key: "jam", title: "AK-I jams after a few stitches", product: "AK-I Cut Pile Tufting Gun" }],
        });
      }
      return aiReply({ title: "AK-I jams after a few stitches", product: "AK-I Cut Pile Tufting Gun", summary: "Lint on the blade.", body: "## How to fix it\n1. Clean the blade\n2. Oil the spring" });
    }));
  });

  it("only picks finished repair-looking conversations we replied to", async () => {
    expect(await pendingCount(env)).toBe(2); // 1 (tagged) and 2 (mentions 'broken'); 3 is still open
  });

  it("files repairs into topics with cases and media, and marks everything read", async () => {
    const r = await scanBatch(env, 4);
    expect(r).toMatchObject({ read: 2, repairs: 1, remaining: 0 });
    expect(r.topics).toEqual([{ id: 1, title: "AK-I jams after a few stitches", isNew: true }]);

    // The photo went to the AI as an image (base64url converted), the video only by name
    const first = calls[0].messages[0].content;
    const img = first.find((b: any) => b.type === "image");
    expect(img.source.data).toBe("iVBORw0KGgo+/");
    expect(img.source.media_type).toBe("image/png"); // labelled image/jpeg, but the bytes are a PNG
    expect(first.some((b: any) => b.text?.includes("noise.mp4"))).toBe(true);

    const topic = db.raw.prepare("SELECT * FROM manual_topics").get() as any;
    expect(topic).toMatchObject({ title: "AK-I jams after a few stitches", status: "draft", summary: "Lint on the blade." });
    expect(topic.body).toContain("Oil the spring");
    const cases = db.raw.prepare("SELECT * FROM manual_cases").all() as any[];
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ ticket_id: 1, outcome: "Fixed by cleaning" });
    const media = db.raw.prepare("SELECT filename, caption FROM manual_media ORDER BY id").all();
    expect(media).toEqual([{ filename: "jam.jpg", caption: "Lint around the blade" }, { filename: "noise.mp4", caption: "Grinding noise" }]);
    const scanned = db.raw.prepare("SELECT ticket_id, result FROM manual_scanned ORDER BY ticket_id").all();
    expect(scanned).toEqual([{ ticket_id: 1, result: "repair" }, { ticket_id: 2, result: "not_repair" }]);

    // Nothing left; a second run is a no-op without calling the AI
    calls.length = 0;
    expect(await scanBatch(env, 4)).toMatchObject({ read: 0 });
    expect(calls).toHaveLength(0);
  });

  it("feeds only published topics to AI drafts", async () => {
    await scanBatch(env, 4);
    expect(await manualKnowledge(env)).toBe("");
    db.raw.exec("UPDATE manual_topics SET status = 'published'");
    expect(await manualKnowledge(env)).toContain("Repair: AK-I jams after a few stitches");
  });
});

describe("AI answers that run long", () => {
  it("retries once with twice the room, then explains; credit and overload errors are worded plainly", async () => {
    const { ask, aiError } = await import("../src/lib/manual");
    const env: any = { DB: testD1(), ANTHROPIC_API_KEY: "test", AI_MODEL: "claude-opus-5-5" };
    const rooms: number[] = [];
    let cut = 1;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      rooms.push(JSON.parse(init.body).max_tokens);
      return aiReply({ ok: true }, cut-- > 0 ? "max_tokens" : "end_turn");
    }));
    expect(await ask(env, [{ type: "text", text: "x" }], { type: "object" }, "low", 1000)).toEqual({ ok: true });
    expect(rooms).toEqual([1000, 2000]);
    cut = 2;
    await expect(ask(env, [{ type: "text", text: "x" }], { type: "object" }, "low", 1000)).rejects.toThrow(/too long to finish/);
    vi.unstubAllGlobals();
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const err = (status: number, message: string) => Anthropic.APIError.generate(status, { error: { message } }, message, new Headers());
    expect((aiError(err(400, "Your credit balance is too low to access the Anthropic API.")) as Error).message).toMatch(/out of credits/);
    expect((aiError(err(529, "Overloaded")) as Error).message).toMatch(/overloaded right now/);
  });
});
