import { beforeEach, describe, expect, it, vi } from "vitest";
import { testD1 } from "./helpers/d1";

const ai = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock("../src/lib/manual", () => ({
  ask: vi.fn(async (_env: unknown, content: { text: string }[]) => {
    ai.prompts.push(content[0].text);
    return { title: "Duo jams after a few stitches", summary: "Yarn or blade.", body: "## How to fix it\n1. Clean the blade\n2. Re-thread", review: ["Duo blade screw location", "  "] };
  }),
}));
vi.mock("../src/lib/ask", () => ({
  askProducts: vi.fn(async () => [{ title: "The Duo — Cut & Loop Tufting Machine", about: "Switches between cut and loop pile." }, { title: "AK-5 Tufting Machine", about: "x" }]),
}));

import { copyTopicFor, productKeys } from "../src/lib/manual-copy";
import { importKb } from "../src/lib/kb";

let env: any;
beforeEach(async () => {
  env = { DB: testD1() };
  ai.prompts.length = 0;
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  env.DB.raw.prepare("INSERT INTO manual_topics (id, title, product, summary, body, status) VALUES (1, 'AK-I jams', 'AK-I Cut Pile Tufting Gun', 'Lint on the blade', '## How to fix it\n1. Loosen the side screw', 'published')").run();
  env.DB.raw.prepare("INSERT INTO manual_topics (id, title, product, summary, body, status) VALUES (2, 'Duo loop height', 'The Duo', 'Pile height', 'Use the front dial.', 'published')").run();
  env.DB.raw.prepare("INSERT INTO tickets (id, subject, customer_email, status, created_at, last_message_at) VALUES (5, 'jam', 'a@b.c', 'closed', '2026-01-01', '2026-01-01')").run();
  env.DB.raw.prepare("INSERT INTO manual_media (topic_id, ticket_id, message_id, attachment_id, filename, mime, caption) VALUES (1, 5, 1, 'a1', 'blade.jpg', 'image/jpeg', 'Lint')").run();
  await importKb(env, { topics: [{ id: "m", name: "Machines" }], articles: [{ id: "duo-guide", topic_id: "m", title: "Getting started with the Duo", html: "<p>The Duo blade is set at the factory.</p>" }] }, 1);
});

describe("copy a repair topic for another machine", () => {
  it("adapts it with what the desk knows about that machine, as a draft with what to check", async () => {
    expect(productKeys("The Duo — Cut & Loop Tufting Machine")).toEqual(["duo"]);
    expect(productKeys("AK-5 Cut & Loop")).toEqual(["ak-5"]);
    const r = await copyTopicFor(env, 1, "The Duo", { notes: "The Duo blade uses the front screw", withMedia: true });
    expect(r).toMatchObject({ review: ["Duo blade screw location"], used: { topics: 1, articles: 1, listing: true } });
    const p = ai.prompts[0];
    expect(p).toContain("Loosen the side screw"); // the original
    expect(p).toContain("Use the front dial."); // the Duo's own topics
    expect(p).toContain("The Duo blade is set at the factory."); // help articles
    expect(p).toContain("Switches between cut and loop pile."); // store listing
    expect(p).toContain("The Duo blade uses the front screw"); // the team's notes
    const copy = env.DB.raw.prepare("SELECT * FROM manual_topics WHERE id = ?").get(r.id);
    expect(copy).toMatchObject({ title: "Duo jams after a few stitches", product: "The Duo", status: "draft", copied_from: 1, edited_at: null });
    expect(copy.body).toBe("## How to fix it\n1. Clean the blade\n2. Re-thread\n\n## Check before publishing\n- Duo blade screw location");
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM manual_media WHERE topic_id = ?").get(r.id).n).toBe(1);
    expect(env.DB.raw.prepare("SELECT body FROM manual_topics WHERE id = 1").get().body).toContain("side screw"); // original untouched
  });

  it("needs a different machine", async () => {
    await expect(copyTopicFor(env, 1, "  ")).rejects.toThrow(/Pick the machine/);
    await expect(copyTopicFor(env, 1, "ak-i cut pile tufting gun")).rejects.toThrow(/already for/);
    await expect(copyTopicFor(env, 99, "The Duo")).rejects.toThrow(/not found/);
  });
});
