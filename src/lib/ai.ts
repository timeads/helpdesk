import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { HttpError, sniffImageType } from "./util";
import { manualKnowledge } from "./manual";
import { kbForAI } from "./kb";

export const aiConfigured = (env: Env) => !!env.ANTHROPIC_API_KEY;

export interface DraftInput {
  storeName: string;
  agentName: string;
  customerName: string | null;
  subject: string;
  thread: { direction: "in" | "out"; from: string; sentAt: string; text: string }[];
  notes: string[];
  orders: unknown[]; // trimmed Shopify orders
  instruction?: string; // optional guidance from the agent, e.g. "offer a replacement"
}

const SYSTEM = `You draft email replies for a small online store's customer support inbox.
Write the reply body only: no subject line, no placeholders like [Name], no signature block (one is appended automatically).
Match a warm, concise, human tone. Use the customer's first name if known.
Ground every factual claim (order status, tracking, items, dates) in the order data provided. If the data doesn't answer the question, say you'll look into it rather than inventing details.
Never promise refunds, replacements or discounts unless the store guidance or the agent's instruction allows it.`;

export async function draftReply(env: Env, input: DraftInput): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(409, "Add an ANTHROPIC_API_KEY to enable AI drafts");
  const about = `${input.subject}\n${input.thread.slice(-4).map((m) => m.text.slice(0, 2000)).join("\n")}`;
  const guidance = [await knowledgeText(env), await kbForAI(env, about).catch(() => "")].filter(Boolean).join("\n\n");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const thread = input.thread
    .map((m) => `--- ${m.direction === "in" ? "Customer" : "Us"} (${m.from}, ${m.sentAt}) ---\n${m.text.slice(0, 6000)}`)
    .join("\n\n");
  const user = [
    `Store: ${input.storeName}. You are writing as ${input.agentName}.`,
    guidance ? `<store_knowledge>\n${guidance}\n</store_knowledge>` : "",
    `<customer_orders>\n${JSON.stringify(input.orders).slice(0, 20000)}\n</customer_orders>`,
    input.notes.length ? `<internal_notes>\n${input.notes.join("\n")}\n</internal_notes>` : "",
    `<conversation subject="${input.subject.replace(/"/g, "'")}">\n${thread}\n</conversation>`,
    input.instruction ? `The agent wants the reply to: ${input.instruction}` : "",
    "Draft the next reply to the customer.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = env.AI_MODEL || "claude-opus-5-5";
  const isHaiku = model.startsWith("claude-haiku");
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
      // Drafting is a light task: low effort keeps each draft to a cent or two.
      ...(isHaiku
        ? {}
        : {
            output_config: { effort: "low" as const },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default" as const,
          }),
    });
    if (response.stop_reason === "refusal") throw new HttpError(422, "The AI declined to draft this one — please write it manually.");
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "The AI returned an empty draft");
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "Anthropic API key was rejected");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "AI is rate limited — try again in a moment");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `AI error: ${e.message}`);
    throw e;
  }
}

/** Active knowledge entries, newest first, capped to keep each request small. Counts a use for each. */
async function knowledgeText(env: Env): Promise<string> {
  const { results } = await env.DB.prepare("SELECT id, name, content FROM knowledge WHERE status = 'active' ORDER BY created_at DESC LIMIT 80").all<{
    id: number;
    name: string;
    content: string;
  }>();
  const repairs = await manualKnowledge(env).catch(() => "");
  if (!results.length) return repairs;
  await env.DB.prepare(`UPDATE knowledge SET uses = uses + 1 WHERE id IN (${results.map(() => "?").join(",")})`).bind(...results.map((r) => r.id)).run();
  return [results.map((r) => `## ${r.name}\n${r.content}`).join("\n\n").slice(0, 40000), repairs].filter(Boolean).join("\n\n");
}

export interface Insights {
  summary: string;
  sentiment: "positive" | "neutral" | "negative";
  type: string;
}

const INSIGHTS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-3 sentences: what the customer wants, what has happened so far, and what is still needed." },
    sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
    type: {
      type: "string",
      enum: ["ORDER_STATUS", "SHIPPING_ISSUE", "RETURN_EXCHANGE", "REFUND", "REPAIR", "PRODUCT_QUESTION", "ORDER_CHANGE", "WHOLESALE", "WORKSHOP", "AFFILIATE", "SALES", "OTHER"],
    },
  },
  required: ["summary", "sentiment", "type"],
  additionalProperties: false,
};

/** Summary, sentiment and conversation type for a ticket (Redo "AI insights"). */
export async function ticketInsights(env: Env, subject: string, thread: DraftInput["thread"]): Promise<Insights> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(409, "Add an Anthropic API key in Settings → Connections to use AI insights");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.AI_MODEL || "claude-opus-5-5";
  const convo = thread.map((m) => `--- ${m.direction === "in" ? "Customer" : "Us"} (${m.sentAt}) ---\n${m.text.slice(0, 4000)}`).join("\n\n");
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1500,
      system: "You triage customer support emails for a rug-tufting supply store. Describe the conversation factually; do not invent order details.",
      messages: [{ role: "user", content: `<conversation subject="${subject.replace(/"/g, "'")}">\n${convo.slice(0, 30000)}\n</conversation>` }],
      output_config: { format: { type: "json_schema", schema: INSIGHTS_SCHEMA }, ...(model.startsWith("claude-haiku") ? {} : { effort: "low" as const }) },
    });
    if (response.stop_reason === "refusal") throw new HttpError(422, "The AI declined to summarise this ticket.");
    const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text) as Insights;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "Anthropic API key was rejected");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `AI error: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------- Live chat

export interface ChatAnswer {
  reply: string;
  handoff: boolean;
  reason: string;
  verify_email?: string; // send a one-time code here so we can look up the customer's orders
}

export interface ChatInput {
  customerName: string | null;
  open: boolean; // a person is around right now
  hours: string;
  transcript: { from: "visitor" | "ai" | "agent"; text: string; photos: number }[];
  orders: unknown[]; // only orders whose email matches the chat's email
  mismatched: string[]; // order numbers mentioned that belong to another email
  chatEmail: string;
  verifiedEmails: string[]; // emails the customer proved with a code: all their orders are in `orders`
  codePending: string | null; // a code was emailed here and hasn't been entered yet
  photos: { mime: string; data: string }[];
  page: string | null;
}

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "The chat message to the customer: plain text, short." },
    handoff: { type: "boolean", description: "True when a teammate needs to take over." },
    reason: { type: "string", description: "One short internal line for the team: what the customer needs and why (not shown to the customer)." },
    verify_email: {
      type: "string",
      description: "To look up the customer's orders without an order number: the email to send a one-time code to (the chat's email, or another one the customer says they ordered with). Empty when not needed.",
    },
  },
  required: ["reply", "handoff", "reason", "verify_email"],
  additionalProperties: false,
};

const CHAT_SYSTEM = `You are the live chat assistant on the website of Tuft the World, a rug-tufting supply store (tufting guns, yarn, cloth, frames, workshops in Philadelphia).

What you can use: <store_knowledge> (knowledge base articles, policies, product info, repair guides and saved replies) and <verified_order> data. If they don't answer the question, don't guess — hand off to a teammate.

How to write: this is a small chat window, so keep each reply to 1–4 short sentences of plain text (no markdown headings or bold). Short numbered steps are fine for troubleshooting. Write as "we" for the store. When a knowledge base article covers their question, answer briefly and include its link. If asked, say you're the store's AI assistant; never claim to be a person.

Orders: only discuss orders inside <verified_order>. When the customer asks about an order (tracking, status, what they bought) and it isn't there:
- If they know the order number (like #68762-TG), they can give it — it counts when the order was placed with the chat's email.
- Otherwise (or if they'd rather not look for it), look their orders up by email: set verify_email to the chat's email — or to another email they say they ordered with — and tell them you've emailed a 6-digit code to type into the chat. Never ask them to prove who they are any other way, and don't keep insisting on the order number.
- While a code is pending, remind them to check their email (and spam folder) for it; set verify_email again only if they ask for a new code or give a different email.
If an order they named is listed under <unverified>, it was placed with a different email: offer to send a code to that email instead (they type it), or have a teammate help.

Never promise refunds, replacements, discounts, warranty decisions, or delivery dates. For those, gather what the team needs (order number, what happened, a photo or video of the problem) and hand off.

Set handoff to true when: they ask for a person; the request needs a decision or money; they're frustrated; you can't resolve it from the knowledge; or they've sent photos of a problem a teammate should look at. When handing off, acknowledge and give any useful last step — the system tells them whether a teammate is joining now or replying by email, so don't promise either.`;

/** The AI's reply in a website chat, as JSON (reply + whether a person should take over). */
export async function chatAnswer(env: Env, input: ChatInput): Promise<ChatAnswer> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(409, "Add an Anthropic API key to use AI chat");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const about = input.transcript.slice(-6).map((m) => m.text).join("\n");
  const [knowledge, macros, articles] = await Promise.all([knowledgeText(env), savedReplies(env), kbForAI(env, about).catch(() => "")]);
  const convo = input.transcript
    .map((m) => `${m.from === "visitor" ? "Customer" : m.from === "ai" ? "You (AI)" : "Teammate"}: ${m.text.slice(0, 3000)}${m.photos ? ` [sent ${m.photos} photo${m.photos > 1 ? "s" : ""}]` : ""}`)
    .join("\n");
  const text = [
    knowledge || macros || articles ? `<store_knowledge>\n${[articles, knowledge, macros].filter(Boolean).join("\n\n")}\n</store_knowledge>` : "",
    input.orders.length ? `<verified_order>\n${JSON.stringify(input.orders).slice(0, 12000)}\n</verified_order>` : "<verified_order>none</verified_order>",
    input.mismatched.length ? `<unverified>${input.mismatched.join(", ")}</unverified>` : "",
    `<identity>Chat email (typed by the customer, not proven): ${input.chatEmail}. Proven with a code: ${input.verifiedEmails.join(", ") || "none"}.${input.codePending ? ` A code was emailed to ${input.codePending} and not entered yet.` : ""}</identity>`,
    `<context>Customer name: ${input.customerName || "unknown"}. Team available right now: ${input.open ? "yes" : `no (hours: ${input.hours})`}.${input.page ? ` Chatting from: ${input.page.slice(0, 200)}` : ""}</context>`,
    `<chat>\n${convo.slice(-30000)}\n</chat>`,
    input.photos.length ? "The customer's most recent photos are attached above." : "",
    "Write the next reply to the customer.",
  ].filter(Boolean).join("\n\n");
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...input.photos.flatMap((p) => {
      const type = sniffImageType(p.data);
      return type ? [{ type: "image" as const, source: { type: "base64" as const, media_type: type, data: p.data } }] : [];
    }),
    { type: "text", text },
  ];
  const model = env.AI_MODEL || "claude-opus-5-5";
  const isHaiku = model.startsWith("claude-haiku");
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      system: CHAT_SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: CHAT_SCHEMA }, ...(isHaiku ? {} : { effort: "low" as const }) },
      ...(isHaiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    if (response.stop_reason === "refusal") return { reply: "Let me get a teammate to help with this one.", handoff: true, reason: "The AI declined to answer" };
    const out = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(out) as ChatAnswer;
    if (!parsed.reply?.trim()) throw new HttpError(502, "The AI returned an empty reply");
    return {
      reply: parsed.reply.trim().slice(0, 2000),
      handoff: !!parsed.handoff,
      reason: String(parsed.reason ?? "").slice(0, 300),
      verify_email: String(parsed.verify_email ?? "").trim().toLowerCase().slice(0, 200),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(502, "Anthropic API key was rejected");
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "AI is rate limited");
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `AI error: ${e.message}`);
    throw e;
  }
}

/** Saved replies (macros) as extra knowledge for chat answers. */
async function savedReplies(env: Env): Promise<string> {
  const { results } = await env.DB.prepare("SELECT name, body FROM macros ORDER BY uses DESC LIMIT 40").all<{ name: string; body: string }>().catch(() => ({ results: [] as { name: string; body: string }[] }));
  return results.map((m) => `## Saved reply: ${m.name}\n${m.body}`).join("\n\n").slice(0, 15000);
}
