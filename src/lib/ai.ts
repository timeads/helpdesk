import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { HttpError, getSetting } from "./util";

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
  const guidance = await getSetting<string>(env, "ai_guidance", "");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const thread = input.thread
    .map((m) => `--- ${m.direction === "in" ? "Customer" : "Us"} (${m.from}, ${m.sentAt}) ---\n${m.text.slice(0, 6000)}`)
    .join("\n\n");
  const user = [
    `Store: ${input.storeName}. You are writing as ${input.agentName}.`,
    guidance ? `<store_guidance>\n${guidance}\n</store_guidance>` : "",
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
