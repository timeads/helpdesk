// "Copy for another machine": a repair topic written for one machine (often a retired one) adapted to another,
// using what the desk knows about the target machine — its other repair topics, help articles and store listing.
// The copy is a draft with a "Check before publishing" list, so nothing reaches customers unreviewed.
import type { Env } from "../env";
import { askProducts } from "./ask";
import { ask } from "./manual";
import { HttpError } from "./util";

const SYSTEM = `You maintain the repair manual for Tuft the World, a store selling rug-tufting machines, tools and supplies.
You adapt an existing repair topic written for one machine so it fits a different machine.
Keep what applies to both machines (general tufting technique, yarn, cloth, frame, needle-depth and blade principles). Change what the target machine does differently, using only the material about the target machine you are given.
Never invent part numbers, measurements, screw locations or steps for the target machine. Where you aren't sure a step carries over, keep it generic and list it under review so a person checks it.`;

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The topic title for the target machine." },
    summary: { type: "string", description: "One or two sentences for the topic list." },
    body: { type: "string", description: "The topic in Markdown with the same sections as the original (## Symptoms, ## Likely causes, ## How to fix it, ## Parts & tools, ## Notes), adapted to the target machine." },
    review: { type: "array", items: { type: "string" }, description: "Short, specific things a person must check before publishing: steps that may not carry over, parts or settings that may differ, anything you weren't sure of. Empty only if everything is clearly the same." },
  },
  required: ["title", "summary", "body", "review"],
  additionalProperties: false,
};

interface Topic { id: number; title: string; product: string; summary: string; body: string }

/** Words of a product name worth matching on ("AK-5 Cut & Loop Tufting Machine" → "ak-5"). */
export function productKeys(product: string) {
  const generic = new Set(["the", "cut", "loop", "pile", "tufting", "machine", "gun", "and", "&", "-"]);
  return product.toLowerCase().split(/[\s,/()]+/).filter((w) => w.length >= 2 && !generic.has(w));
}

/** What the desk knows about the target machine, trimmed for the prompt. */
async function aboutMachine(env: Env, product: string, skipId: number) {
  const keys = productKeys(product);
  if (!keys.length) return { topics: [] as Topic[], articles: [] as { title: string; text: string }[], listing: "" };
  const like = keys.map(() => "lower(product || ' ' || title) LIKE ?").join(" OR ");
  const { results: topics } = await env.DB.prepare(
    `SELECT id, title, product, summary, body FROM manual_topics WHERE id != ? AND (${like}) ORDER BY status = 'published' DESC, updated_at DESC LIMIT 6`,
  ).bind(skipId, ...keys.map((k) => `%${k}%`)).all<Topic>();
  const alike = keys.map(() => "(lower(title) LIKE ? OR lower(body_text) LIKE ?)").join(" OR ");
  const { results: articles } = await env.DB.prepare(
    `SELECT title, body_text AS text FROM kb_articles WHERE status = 'published' AND (${alike}) ORDER BY (${keys.map(() => "lower(title) LIKE ?").join(" OR ")}) DESC LIMIT 4`,
  ).bind(...keys.flatMap((k) => [`%${k}%`, `%${k}%`]), ...keys.map((k) => `%${k}%`)).all<{ title: string; text: string }>();
  const products = await askProducts(env).catch(() => []);
  const match = products.find((p) => keys.every((k) => p.title.toLowerCase().includes(k))) ?? products.find((p) => keys.some((k) => p.title.toLowerCase().includes(k)));
  return { topics, articles, listing: match ? `${match.title}: ${match.about}`.slice(0, 2500) : "" };
}

export async function copyTopicFor(env: Env, sourceId: number, product: string, opts: { notes?: string; withMedia?: boolean } = {}) {
  const target = product.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!target) throw new HttpError(400, "Pick the machine to copy it for");
  const src = await env.DB.prepare("SELECT id, title, product, summary, body FROM manual_topics WHERE id = ?").bind(sourceId).first<Topic>();
  if (!src) throw new HttpError(404, "Topic not found");
  if (src.product.trim().toLowerCase() === target.toLowerCase()) throw new HttpError(400, "That's the machine this topic is already for");
  const about = await aboutMachine(env, target, src.id);
  const text = [
    `<original machine="${src.product || "unknown"}">\nTitle: ${src.title}\nSummary: ${src.summary}\n\n${src.body || "(no write-up)"}\n</original>`,
    `<target_machine>${target}</target_machine>`,
    about.listing ? `<store_listing>\n${about.listing}\n</store_listing>` : "",
    about.topics.length ? `<target_machine_repair_topics>\n${about.topics.map((t) => `## ${t.title} (${t.product})\n${t.summary}\n${t.body}`).join("\n\n").slice(0, 20000)}\n</target_machine_repair_topics>` : "<target_machine_repair_topics>none yet</target_machine_repair_topics>",
    about.articles.length ? `<help_articles>\n${about.articles.map((a) => `## ${a.title}\n${a.text}`).join("\n\n").slice(0, 12000)}\n</help_articles>` : "",
    opts.notes?.trim() ? `<notes_from_the_team>\n${opts.notes.trim().slice(0, 2000)}\n</notes_from_the_team>` : "",
    `Adapt the original topic for the ${target}. Follow the team's notes where given.`,
  ].filter(Boolean).join("\n\n");
  const w = await ask<{ title: string; summary: string; body: string; review: string[] }>(env, [{ type: "text", text }], SCHEMA, "medium", 12000, SYSTEM, "Repair manual");
  const review = (w.review ?? []).map((r) => String(r).trim()).filter(Boolean).slice(0, 12);
  const body = `${w.body.trim()}${review.length ? `\n\n## Check before publishing\n${review.map((r) => `- ${r}`).join("\n")}` : ""}`;
  const row = await env.DB.prepare(
    "INSERT INTO manual_topics (title, product, summary, body, status, copied_from) VALUES (?, ?, ?, ?, 'draft', ?) RETURNING id",
  ).bind((w.title || src.title).slice(0, 160), target, (w.summary ?? "").slice(0, 500), body.slice(0, 40000), src.id).first<{ id: number }>();
  if (opts.withMedia) {
    await env.DB.prepare(
      "INSERT INTO manual_media (topic_id, ticket_id, message_id, attachment_id, filename, mime, caption) SELECT ?, ticket_id, message_id, attachment_id, filename, mime, caption FROM manual_media WHERE topic_id = ?",
    ).bind(row!.id, src.id).run();
  }
  return { id: row!.id, review, used: { topics: about.topics.length, articles: about.articles.length, listing: !!about.listing } };
}
