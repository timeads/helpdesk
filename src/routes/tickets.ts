import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { DEFAULT_RULES, getAttachment, getMailbox, importMessage, modifyThread, sendRaw, syncMailbox, type MailRules } from "../lib/gmail";
import { buildMime, encodeRaw, replySubject, type OutgoingAttachment } from "../lib/mime";
import { customerProfile, shopifyConfigured } from "../lib/shopify";
import { aiConfigured, draftReply } from "../lib/ai";
import { demoProfile } from "../lib/demo";
import { HttpError, base64UrlDecodeBytes, getSetting, nowIso } from "../lib/util";

const tickets = new Hono<AppEnv>();

const STATUSES = ["open", "pending", "closed"] as const;

function viewWhere(view: string, agentId: number): { sql: string; args: unknown[] } {
  switch (view) {
    case "mine":
      return { sql: "t.status = 'open' AND t.assignee_id = ?", args: [agentId] };
    case "unassigned":
      return { sql: "t.status = 'open' AND t.assignee_id IS NULL", args: [] };
    case "pending":
      return { sql: "t.status = 'pending'", args: [] };
    case "closed":
      return { sql: "t.status = 'closed'", args: [] };
    case "all":
      return { sql: "1 = 1", args: [] };
    default:
      return { sql: "t.status = 'open'", args: [] };
  }
}

tickets.get("/counts", async (c) => {
  const me = c.get("agent").id;
  const row = await c.env.DB.prepare(
    `SELECT
       SUM(status = 'open') AS open,
       SUM(status = 'open' AND assignee_id = ?) AS mine,
       SUM(status = 'open' AND assignee_id IS NULL) AS unassigned,
       SUM(status = 'pending') AS pending
     FROM tickets`,
  )
    .bind(me)
    .first();
  return c.json(row);
});

tickets.get("/", async (c) => {
  const view = c.req.query("view") ?? "open";
  const q = (c.req.query("q") ?? "").trim();
  const before = c.req.query("before");
  const where = viewWhere(view, c.get("agent").id);
  const clauses = [where.sql];
  const args = [...where.args];
  if (q) {
    const like = `%${q}%`;
    clauses.push("(t.subject LIKE ? OR t.customer_email LIKE ? OR t.customer_name LIKE ? OR t.snippet LIKE ? OR CAST(t.id AS TEXT) = ?)");
    args.push(like, like, like, like, q.replace(/^#/, ""));
  }
  if (before) {
    clauses.push("t.last_message_at < ?");
    args.push(before);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.subject, t.customer_email, t.customer_name, t.status, t.assignee_id, a.name AS assignee_name,
            t.unread, t.snippet, t.message_count, t.last_message_at, t.last_inbound_at, t.created_at
     FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.last_message_at DESC LIMIT 50`,
  )
    .bind(...args)
    .all();
  return c.json({ tickets: results });
});

async function loadTicket(env: Env, id: number) {
  const t = await env.DB.prepare(
    `SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN agents a ON a.id = t.assignee_id WHERE t.id = ?`,
  )
    .bind(id)
    .first<any>();
  if (!t) throw new HttpError(404, "Ticket not found");
  return t;
}

tickets.get("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const ticket = await loadTicket(c.env, id);
  const [messages, notes, events] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT m.id, m.direction, m.from_email, m.from_name, m.to_emails, m.cc_emails, m.subject, m.sent_at,
              m.body_text, m.body_html, m.attachments, m.gmail_message_id, a.name AS agent_name
       FROM messages m LEFT JOIN agents a ON a.id = m.agent_id WHERE m.ticket_id = ? ORDER BY m.sent_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT n.id, n.body, n.created_at, a.name AS agent_name FROM notes n LEFT JOIN agents a ON a.id = n.agent_id WHERE n.ticket_id = ? ORDER BY n.created_at`,
    ).bind(id),
    c.env.DB.prepare(
      `SELECT e.kind, e.detail, e.created_at, a.name AS agent_name FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.ticket_id = ? ORDER BY e.created_at`,
    ).bind(id),
  ]);
  if (ticket.unread) await c.env.DB.prepare("UPDATE tickets SET unread = 0 WHERE id = ?").bind(id).run();
  return c.json({
    ticket: { ...ticket, unread: 0 },
    messages: messages.results.map((m: any) => ({ ...m, attachments: JSON.parse(m.attachments || "[]") })),
    notes: notes.results,
    events: events.results,
  });
});

async function archiveIfClosed(env: Env, threadId: string | null, status: string) {
  if (!threadId || status !== "closed") return;
  const rules = { ...DEFAULT_RULES, ...(await getSetting<Partial<MailRules>>(env, "mail_rules", {})) };
  if (!rules.archiveOnClose) return;
  try {
    await modifyThread(env, threadId, [], ["INBOX", "UNREAD"]);
  } catch {
    /* Archiving in Gmail is a convenience; never fail the request over it */
  }
}

async function applyStatus(env: Env, ticket: any, status: string, agentId: number) {
  if (!STATUSES.includes(status as any)) throw new HttpError(400, "Unknown status");
  if (ticket.status === status) return [];
  return [
    env.DB.prepare("UPDATE tickets SET status = ?, closed_at = ? WHERE id = ?").bind(
      status,
      status === "closed" ? nowIso() : null,
      ticket.id,
    ),
    env.DB.prepare("INSERT INTO events (ticket_id, agent_id, kind, detail) VALUES (?, ?, 'status', ?)").bind(
      ticket.id,
      agentId,
      status,
    ),
  ];
}

tickets.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent");
  const body = await c.req.json<{ status?: string; assignee_id?: number | null; unread?: boolean }>();
  const ticket = await loadTicket(c.env, id);
  const stmts: D1PreparedStatement[] = [];
  if (body.status) stmts.push(...(await applyStatus(c.env, ticket, body.status, me.id)));
  if (body.assignee_id !== undefined && body.assignee_id !== ticket.assignee_id) {
    let name = "nobody";
    if (body.assignee_id !== null) {
      const a = await c.env.DB.prepare("SELECT name FROM agents WHERE id = ? AND active = 1").bind(body.assignee_id).first<{ name: string }>();
      if (!a) throw new HttpError(400, "Unknown agent");
      name = a.name;
    }
    stmts.push(
      c.env.DB.prepare("UPDATE tickets SET assignee_id = ? WHERE id = ?").bind(body.assignee_id, id),
      c.env.DB.prepare("INSERT INTO events (ticket_id, agent_id, kind, detail) VALUES (?, ?, 'assigned', ?)").bind(id, me.id, name),
    );
  }
  if (body.unread !== undefined) stmts.push(c.env.DB.prepare("UPDATE tickets SET unread = ? WHERE id = ?").bind(body.unread ? 1 : 0, id));
  if (stmts.length) await c.env.DB.batch(stmts);
  if (body.status) c.executionCtx.waitUntil(archiveIfClosed(c.env, ticket.gmail_thread_id, body.status));
  return c.json({ ticket: await loadTicket(c.env, id) });
});

tickets.post("/:id{[0-9]+}/notes", async (c) => {
  const id = Number(c.req.param("id"));
  const { body } = await c.req.json<{ body: string }>();
  if (!body?.trim()) throw new HttpError(400, "Note is empty");
  await loadTicket(c.env, id);
  await c.env.DB.prepare("INSERT INTO notes (ticket_id, agent_id, body) VALUES (?, ?, ?)").bind(id, c.get("agent").id, body.trim()).run();
  return c.json({ ok: true });
});

tickets.post("/:id{[0-9]+}/reply", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("agent");
  const body = await c.req.json<{
    text: string;
    cc?: string[];
    status?: "open" | "pending" | "closed";
    attachments?: OutgoingAttachment[];
  }>();
  if (!body.text?.trim()) throw new HttpError(400, "Reply is empty");
  const totalSize = (body.attachments ?? []).reduce((n, a) => n + a.base64.length * 0.75, 0);
  if (totalSize > 20 * 1024 * 1024) throw new HttpError(413, "Attachments are over Gmail's 25 MB limit");

  const ticket = await loadTicket(c.env, id);
  const box = await getMailbox(c.env);
  if (!box) throw new HttpError(409, "Connect the support mailbox in Settings first");

  const { results: refs } = await c.env.DB.prepare(
    "SELECT rfc_message_id FROM messages WHERE ticket_id = ? AND rfc_message_id IS NOT NULL ORDER BY sent_at",
  )
    .bind(id)
    .all<{ rfc_message_id: string }>();
  const ids = refs.map((r) => r.rfc_message_id);
  const signature = me.signature?.trim() || (await getSetting<string>(c.env, "signature", "")).trim();
  const text = body.text.trim() + (signature ? `\n\n${signature}` : "");

  const mime = buildMime({
    fromEmail: box.email,
    fromName: c.env.APP_NAME,
    to: [ticket.customer_email],
    cc: body.cc?.filter(Boolean),
    subject: replySubject(ticket.subject),
    inReplyTo: ids.at(-1) ?? null,
    references: ids.slice(-20).join(" ") || null,
    text,
    attachments: body.attachments,
  });
  const sent = await sendRaw(c.env, encodeRaw(mime), ticket.gmail_thread_id);
  await importMessage(c.env, sent.id, { agentId: me.id, force: true });

  const status = body.status ?? "pending";
  const stmts = [
    ...(await applyStatus(c.env, ticket, status, me.id)),
    c.env.DB.prepare("UPDATE tickets SET unread = 0, assignee_id = COALESCE(assignee_id, ?) WHERE id = ?").bind(me.id, id),
  ];
  if (!ticket.gmail_thread_id) stmts.push(c.env.DB.prepare("UPDATE tickets SET gmail_thread_id = ? WHERE id = ?").bind(sent.threadId, id));
  await c.env.DB.batch(stmts);
  c.executionCtx.waitUntil(archiveIfClosed(c.env, sent.threadId, status));
  return c.json({ ok: true, ticket: await loadTicket(c.env, id) });
});

tickets.post("/:id{[0-9]+}/ai-draft", async (c) => {
  const id = Number(c.req.param("id"));
  const { instruction } = await c.req.json<{ instruction?: string }>().catch(() => ({ instruction: undefined }));
  if (!aiConfigured(c.env)) throw new HttpError(409, "AI drafts are off — add an ANTHROPIC_API_KEY to turn them on.");
  const ticket = await loadTicket(c.env, id);
  const [{ results: messages }, { results: notes }] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT direction, from_email, sent_at, body_text FROM messages WHERE ticket_id = ? ORDER BY sent_at").bind(id),
    c.env.DB.prepare("SELECT body FROM notes WHERE ticket_id = ? ORDER BY created_at").bind(id),
  ]);
  let orders: unknown[] = [];
  if (shopifyConfigured(c.env)) {
    try {
      const p = await customerProfile(c.env, ticket.customer_email);
      orders = p.orders.slice(0, 5).map((o) => ({
        name: o.name,
        placed: o.createdAt,
        financial: o.displayFinancialStatus,
        fulfillment: o.displayFulfillmentStatus,
        cancelled: !!o.cancelledAt,
        total: o.totalPriceSet.shopMoney,
        items: o.lineItems.nodes.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`),
        shipping: o.shippingLines.nodes[0]?.title,
        tracking: o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => ({ status: f.displayStatus, ...t }))),
      }));
    } catch {
      /* draft without order context */
    }
  }
  const draft = await draftReply(c.env, {
    storeName: c.env.APP_NAME,
    agentName: c.get("agent").name,
    customerName: ticket.customer_name,
    subject: ticket.subject,
    thread: (messages as any[]).map((m) => ({ direction: m.direction, from: m.from_email, sentAt: m.sent_at, text: m.body_text })),
    notes: (notes as any[]).map((n) => n.body),
    orders,
    instruction,
  });
  return c.json({ draft });
});

tickets.get("/:id{[0-9]+}/messages/:mid{[0-9]+}/attachments/:aid", async (c) => {
  const m = await c.env.DB.prepare("SELECT gmail_message_id, attachments FROM messages WHERE id = ? AND ticket_id = ?")
    .bind(Number(c.req.param("mid")), Number(c.req.param("id")))
    .first<{ gmail_message_id: string; attachments: string }>();
  if (!m) throw new HttpError(404, "Not found");
  const meta = (JSON.parse(m.attachments) as { id: string; filename: string; mimeType: string }[]).find(
    (a) => a.id === c.req.param("aid"),
  );
  if (!meta) throw new HttpError(404, "Attachment not found");
  const data = await getAttachment(c.env, m.gmail_message_id, meta.id);
  const inline = /^(image\/|application\/pdf)/.test(meta.mimeType) && c.req.query("download") === undefined;
  return new Response(base64UrlDecodeBytes(data), {
    headers: {
      "content-type": meta.mimeType,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    },
  });
});

tickets.post("/sync", async (c) => {
  const r = await syncMailbox(c.env);
  return c.json(r);
});

tickets.get("/customer/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const { results: history } = await c.env.DB.prepare(
    "SELECT id, subject, status, last_message_at FROM tickets WHERE customer_email = ? ORDER BY last_message_at DESC LIMIT 20",
  )
    .bind(email)
    .all();
  let shopify: unknown = null;
  let shopifyError: string | null = null;
  if (shopifyConfigured(c.env)) {
    try {
      shopify = await customerProfile(c.env, email);
    } catch (e) {
      shopifyError = (e as Error).message;
    }
  } else if (c.env.DEMO_DATA === "1") shopify = demoProfile(email);
  else shopifyError = "not_configured";
  return c.json({ email, tickets: history, shopify, shopifyError });
});

export default tickets;
