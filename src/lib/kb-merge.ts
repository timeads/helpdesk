// Keeping the knowledge base tidy with AI: find articles that cover the same thing and merge them
// into one; fold suggestions from support conversations into the right article (rewriting it so
// nothing is repeated) instead of tacking sections on the end; and, when auto-merge is on, do both
// for new conversations by themselves. Every article is saved to kb_versions before it changes.
import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { ask } from "./manual";
import { cleanHtml, kbArticles, kbPending, kbScanBatch, rankArticles, slugify, textOf, uniqueId, type KbArticle } from "./kb";
import { shopify } from "./shopify";
import { HttpError, getSetting, nowIso, setSetting } from "./util";

const EDITOR_SYSTEM = `You edit the customer knowledge base of Tuft the World, a store selling rug-tufting guns, yarn, cloth, frames and adhesive.
Write for customers, in the store's friendly, practical voice. Keep every fact, step, measurement, product link and photo from the material you're given, but say each thing once: combine repeated points, put steps in a sensible order, and use clear headings. Don't invent facts. Never include anything about a single order or person.
Output simple HTML only: <p>, <h3>, <h4>, <ul>/<ol>/<li>, <strong>, <em>, <a href>, <img src alt>, <blockquote>. Keep every <img> tag exactly as given (same src).`;

const ARTICLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The article title, phrased the way a customer would ask or search." },
    body_html: { type: "string", description: "The whole article as simple HTML." },
    description: { type: "string", description: "Search snippet: one or two sentences, under 155 characters." },
  },
  required: ["title", "body_html", "description"],
  additionalProperties: false,
};
type Written = { title: string; body_html: string; description: string };

/** Saves the article as it is now, so the change about to happen can be undone. */
export async function saveVersion(env: Env, a: Pick<KbArticle, "id" | "title" | "topic_id" | "body_html" | "status"> & { description?: string }, reason: string, agentId: number | null) {
  await env.DB.prepare("INSERT INTO kb_versions (article_id, title, topic_id, body_html, description, status, reason, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(a.id, a.title, a.topic_id, a.body_html, a.description ?? "", a.status, reason.slice(0, 300), agentId).run();
}

const srcs = (html: string) => Array.from(html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/g), (m) => ({ src: m[1], tag: m[0] }));

/** The AI's article, cleaned: only photos that were in the originals, and none of them lost. */
function finishBody(written: string, sources: string[]): string {
  const known = new Map(sources.flatMap(srcs).map((x) => [x.src, x.tag]));
  let html = cleanHtml(written).replace(/<img\b[^>]*>/g, (tag) => {
    const src = tag.match(/src="([^"]+)"/)?.[1];
    return src && known.has(src) ? tag : "";
  });
  const kept = new Set(srcs(html).map((x) => x.src));
  const lost = [...known.entries()].filter(([src]) => !kept.has(src));
  if (lost.length) html += `\n<h3>Photos</h3>\n${lost.map(([, tag]) => `<p>${tag}</p>`).join("\n")}`;
  return html;
}

async function write(env: Env, prompt: string, material: string): Promise<Written> {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: material }, { type: "text", text: prompt }];
  const r = await ask<Written>(env, content, ARTICLE_SCHEMA, "medium", 16000, EDITOR_SYSTEM);
  if (!textOf(r.body_html ?? "")) throw new HttpError(502, "The AI returned an empty article");
  return r;
}

// ---- Duplicates

export interface DuplicateGroup { keep: string; merge: string[]; title: string; reason: string }

const GROUPS_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keep: { type: "string", description: "Id of the article to keep (prefer one already on the store, then a published one, then the most complete)." },
          merge: { type: "array", items: { type: "string" }, description: "Ids of the articles that say the same thing and should be folded into it." },
          title: { type: "string", description: "A good title for the merged article." },
          reason: { type: "string", description: "One line: what these articles all cover." },
        },
        required: ["keep", "merge", "title", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

/** Asks the AI which articles cover the same subject. Saved, so the page can show them for review. */
export async function findDuplicates(env: Env): Promise<DuplicateGroup[]> {
  const all = await kbArticles(env);
  if (all.length < 2) return [];
  const index = all.map((a) => `[${a.id}] (${a.topic_id}; ${a.status}${a.shopify_id ? "; on store" : ""}; ${a.body_text.split(/\s+/).length} words) ${a.title}: ${a.body_text.slice(0, 350).replace(/\s+/g, " ")}`).join("\n");
  const r = await ask<{ groups: DuplicateGroup[] }>(
    env,
    [{ type: "text", text: `<articles>\n${index}\n</articles>` },
      { type: "text", text: "Group the articles that are duplicates or near-duplicates — the same question or subject, where one good article would serve customers better than several. Don't group articles that are merely related (e.g. two different machines, or setup vs. troubleshooting). Leave everything else out." }],
    GROUPS_SCHEMA, "medium", 8000, EDITOR_SYSTEM,
  );
  const ids = new Set(all.map((a) => a.id));
  const used = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const g of r.groups ?? []) {
    const merge = [...new Set(g.merge)].filter((id) => ids.has(id) && id !== g.keep && !used.has(id));
    if (!ids.has(g.keep) || used.has(g.keep) || !merge.length) continue;
    [g.keep, ...merge].forEach((id) => used.add(id));
    groups.push({ keep: g.keep, merge, title: String(g.title || "").slice(0, 200), reason: String(g.reason || "").slice(0, 300) });
  }
  await setSetting(env, "kb_duplicates", { at: nowIso(), groups });
  return groups;
}

/** Folds `mergeIds` into `keepId`: one rewritten article, the others removed (and redirected on the store). */
export async function mergeArticles(env: Env, keepId: string, mergeIds: string[], agentId: number | null, title?: string) {
  const ids = [keepId, ...mergeIds.filter((x) => x !== keepId)];
  const rows = (await env.DB.prepare(`SELECT * FROM kb_articles WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<KbArticle>()).results;
  const keep = rows.find((a) => a.id === keepId);
  const others = rows.filter((a) => a.id !== keepId);
  if (!keep) throw new HttpError(404, "The article to keep no longer exists");
  if (!others.length) return { merged: 0 };
  const material = rows.map((a) => `<article id="${a.id}" title="${a.title.replace(/"/g, "'")}">\n${a.body_html}\n</article>`).join("\n\n");
  const w = await write(env, `Merge these ${rows.length} articles into one article${title ? ` titled roughly "${title}"` : ""}. Keep everything useful from each, without repeating anything.`, material);
  for (const a of rows) await saveVersion(env, a, `Before merging ${others.length + 1} articles into “${w.title}”`, agentId);
  const body = finishBody(w.body_html, rows.map((a) => a.body_html));
  const status = rows.some((a) => a.status === "published") ? "published" : keep.status;
  await env.DB.prepare(
    `UPDATE kb_articles SET title = ?, body_html = ?, body_text = ?, description = ?, status = ?, use_in_ai = 1, edited_by = ?, updated_at = ? WHERE id = ?`,
  ).bind(w.title.slice(0, 200) || keep.title, body, textOf(body), (w.description || "").slice(0, 300), status, agentId, nowIso(), keep.id).run();
  for (const a of others) {
    if (a.shopify_id) await removeFromStore(env, a, keep);
    await env.DB.batch([
      env.DB.prepare("UPDATE kb_suggestions SET article_id = ? WHERE article_id = ?").bind(keep.id, a.id),
      env.DB.prepare("DELETE FROM kb_articles WHERE id = ?").bind(a.id),
    ]);
  }
  return { merged: others.length, title: w.title };
}

/** Takes a merged-away article off the store, pointing its old address at the article it joined. */
async function removeFromStore(env: Env, gone: KbArticle, into: KbArticle) {
  try {
    await shopify(env, `mutation KbArticleDelete($id: ID!) { articleDelete(id: $id) { deletedArticleId userErrors { field message } } }`, { id: gone.shopify_id });
    if (gone.shopify_handle && into.shopify_handle) {
      await shopify(env, `mutation KbRedirect($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } } }`, {
        r: { path: `/blogs/knowledge-base/${gone.shopify_handle}`, target: `/blogs/knowledge-base/${into.shopify_handle}` },
      });
    }
  } catch (e) {
    console.error("kb merge: store cleanup", gone.id, e); // the merge itself still stands
  }
}

// ---- Folding suggestions into articles

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          suggestion_id: { type: "integer" },
          article_id: { type: "string", description: "Existing article that should include it, or empty when no article covers the subject." },
          new_title: { type: "string", description: "When no article covers it: the title for a new article. Suggestions about the same new subject get the same title." },
        },
        required: ["suggestion_id", "article_id", "new_title"],
        additionalProperties: false,
      },
    },
  },
  required: ["routes"],
  additionalProperties: false,
};

/**
 * Takes the waiting suggestions into the knowledge base the careful way: each is routed to the
 * article that covers its subject, and that article is rewritten to include it (once). Subjects no
 * article covers become new draft articles. Does a couple of articles per call; call until remaining is 0.
 */
export async function integrateSuggestions(env: Env, agentId: number | null, articlesPerCall = 2) {
  const all = await kbArticles(env);
  const ids = new Set(all.map((a) => a.id));

  // 1. Route suggestions that don't name an article (or name one that's gone)
  const { results: loose } = await env.DB.prepare(
    `SELECT id, topic_id, title, content_html FROM kb_suggestions WHERE status = 'pending' AND (article_id IS NULL OR article_id NOT IN (SELECT id FROM kb_articles)) ORDER BY id LIMIT 12`,
  ).all<{ id: number; topic_id: string | null; title: string; content_html: string }>();
  let created = 0;
  if (loose.length) {
    const candidates = new Map<string, KbArticle>();
    for (const s of loose) for (const a of rankArticles(all, `${s.title} ${textOf(s.content_html)}`, 4)) candidates.set(a.id, a);
    const index = (candidates.size ? [...candidates.values()] : all.slice(0, 40)).map((a) => `[${a.id}] ${a.title}: ${a.body_text.slice(0, 300).replace(/\s+/g, " ")}`).join("\n");
    const r = await ask<{ routes: { suggestion_id: number; article_id: string; new_title: string }[] }>(
      env,
      [{ type: "text", text: `<articles>\n${index}\n</articles>\n\n<suggestions>\n${loose.map((s) => `[${s.id}] ${s.title}: ${textOf(s.content_html).slice(0, 600)}`).join("\n")}\n</suggestions>` },
        { type: "text", text: "For each suggestion, pick the existing article whose subject it belongs in, or give a new article title when none fits." }],
      ROUTE_SCHEMA, "low", 3000, EDITOR_SYSTEM,
    );
    const newGroups = new Map<string, { title: string; topic: string | null; ids: number[]; html: string[] }>();
    for (const s of loose) {
      const route = r.routes.find((x) => x.suggestion_id === s.id);
      if (route && ids.has(route.article_id)) {
        await env.DB.prepare("UPDATE kb_suggestions SET article_id = ? WHERE id = ?").bind(route.article_id, s.id).run();
        continue;
      }
      const title = (route?.new_title || s.title || "New article").trim();
      const key = slugify(title);
      const g = newGroups.get(key) ?? { title, topic: s.topic_id, ids: [], html: [] };
      g.ids.push(s.id);
      g.html.push(cleanHtml(s.content_html));
      newGroups.set(key, g);
    }
    // New subjects: one draft article each, written from all the suggestions about it
    for (const g of newGroups.values()) {
      const w = g.html.length > 1 ? await write(env, `Write one article titled roughly "${g.title}" from these notes.`, g.html.join("\n\n")) : { title: g.title, body_html: g.html[0], description: "" };
      const id = await uniqueId(env, slugify(w.title));
      const topic = g.topic && (await env.DB.prepare("SELECT 1 FROM kb_topics WHERE id = ?").bind(g.topic).first()) ? g.topic : all[0]?.topic_id;
      const body = finishBody(w.body_html, g.html);
      await env.DB.prepare("INSERT INTO kb_articles (id, topic_id, title, body_html, body_text, description, status, position, edited_by) VALUES (?, ?, ?, ?, ?, ?, 'draft', 999, ?)")
        .bind(id, topic, w.title.slice(0, 200), body, textOf(body), (w.description || "").slice(0, 300), agentId).run();
      await env.DB.prepare(`UPDATE kb_suggestions SET status = 'accepted', article_id = ? WHERE id IN (${g.ids.map(() => "?").join(",")})`).bind(id, ...g.ids).run();
      created++;
    }
  }

  // 2. Rewrite a couple of articles to take in their suggestions
  const { results: targets } = await env.DB.prepare(
    `SELECT article_id, COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending' AND article_id IN (SELECT id FROM kb_articles) GROUP BY article_id ORDER BY MIN(id) LIMIT ?`,
  ).bind(articlesPerCall).all<{ article_id: string; n: number }>();
  let updated = 0;
  let folded = 0;
  for (const t of targets) {
    const a = await env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(t.article_id).first<KbArticle>();
    const { results: subs } = await env.DB.prepare("SELECT id, title, content_html FROM kb_suggestions WHERE status = 'pending' AND article_id = ? ORDER BY id LIMIT 25")
      .bind(t.article_id).all<{ id: number; title: string; content_html: string }>();
    if (!a || !subs.length) continue;
    const additions = subs.map((s) => `<addition heading="${s.title.replace(/"/g, "'")}">\n${cleanHtml(s.content_html)}\n</addition>`).join("\n");
    const w = await write(env,
      "Update the article so it also covers the additions. Work each new point into the right place; skip anything the article already says. Keep the title unless an addition changes what the article is about.",
      `<article id="${a.id}" title="${a.title.replace(/"/g, "'")}">\n${a.body_html}\n</article>\n\n<additions>\n${additions}\n</additions>`);
    await saveVersion(env, a, `Before adding ${subs.length} suggestion${subs.length === 1 ? "" : "s"} from support conversations`, agentId);
    const body = finishBody(w.body_html, [a.body_html, ...subs.map((s) => s.content_html)]);
    await env.DB.prepare("UPDATE kb_articles SET title = ?, body_html = ?, body_text = ?, edited_by = ?, updated_at = ? WHERE id = ?")
      .bind(w.title.slice(0, 200) || a.title, body, textOf(body), agentId, nowIso(), a.id).run();
    await env.DB.prepare(`UPDATE kb_suggestions SET status = 'accepted' WHERE id IN (${subs.map(() => "?").join(",")})`).bind(...subs.map((s) => s.id)).run();
    updated++;
    folded += subs.length;
  }
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'").first<{ n: number }>();
  return { updated, created, folded, remaining: left?.n ?? 0 };
}

// ---- Auto-merge: new conversations go into the knowledge base by themselves

export const autoMergeOn = (env: Env) => getSetting<boolean>(env, "kb_auto_merge", false);

/**
 * From the minute cron when auto-merge is on: at most one step every 10 minutes — read a few new
 * conversations, or fold waiting suggestions into their articles. Merged articles still need
 * “Publish to store” before customers see them.
 */
export async function autoMergeTick(env: Env) {
  if (!env.ANTHROPIC_API_KEY || !(await autoMergeOn(env))) return;
  const last = await getSetting<string | null>(env, "kb_auto_merge_at", null);
  if (last && Date.now() - Date.parse(last) < 10 * 60_000) return;
  if (!(await env.DB.prepare("SELECT 1 FROM kb_articles LIMIT 1").first())) return;
  await setSetting(env, "kb_auto_merge_at", nowIso());
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM kb_suggestions WHERE status = 'pending'").first<{ n: number }>();
  if ((waiting?.n ?? 0) > 0) await integrateSuggestions(env, null, 1);
  else if ((await kbPending(env)) > 0) await kbScanBatch(env, 4);
}

/** Earlier versions of an article, newest first. */
export async function versionsOf(env: Env, articleId: string) {
  return (await env.DB.prepare("SELECT id, title, reason, saved_at, agent_id FROM kb_versions WHERE article_id = ? ORDER BY saved_at DESC, id DESC LIMIT 30").bind(articleId).all()).results;
}

/** Puts an earlier version back (the current one is saved first, so this can be undone too). */
export async function restoreVersion(env: Env, versionId: number, agentId: number) {
  const v = await env.DB.prepare("SELECT * FROM kb_versions WHERE id = ?").bind(versionId).first<any>();
  if (!v) throw new HttpError(404, "That version no longer exists");
  const cur = await env.DB.prepare("SELECT * FROM kb_articles WHERE id = ?").bind(v.article_id).first<KbArticle>();
  if (cur) {
    await saveVersion(env, cur, "Before restoring an earlier version", agentId);
    await env.DB.prepare("UPDATE kb_articles SET title = ?, topic_id = ?, body_html = ?, body_text = ?, description = ?, edited_by = ?, updated_at = ? WHERE id = ?")
      .bind(v.title, v.topic_id, v.body_html, textOf(v.body_html), v.description, agentId, nowIso(), v.article_id).run();
  } else {
    // A merged-away article comes back as a draft
    await env.DB.prepare("INSERT INTO kb_articles (id, topic_id, title, body_html, body_text, description, status, position, edited_by) VALUES (?, ?, ?, ?, ?, ?, 'draft', 999, ?)")
      .bind(v.article_id, v.topic_id, v.title, v.body_html, textOf(v.body_html), v.description, agentId).run();
  }
  return { articleId: v.article_id };
}
