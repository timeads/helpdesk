import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { HttpError } from "./util";
import { manualKnowledge } from "./manual";

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
  const guidance = await knowledgeText(env);
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
