import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testD1 } from "./helpers/d1";
import tickets from "../src/routes/tickets";
import admin from "../src/routes/admin";
import { HttpError } from "../src/lib/util";

let env: any;
const app = new Hono<any>();
app.use(async (c, next) => { c.set("agent", { id: 1, name: "Tim", role: "admin" }); await next(); });
app.route("/tickets", tickets);
app.route("/", admin);
app.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? (err.status as any) : 500));
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env, { waitUntil: () => {} } as any);
  return { status: r.status, json: (await r.json()) as any };
};
const ids = async (q: string) => (await call("GET", `/tickets?${q}`)).json.tickets.map((t: any) => t.id);

beforeEach(() => {
  env = { DB: testD1() };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name, role) VALUES (1, 'tim@x.com', 'Tim', 'admin')").run();
  const now = new Date().toISOString();
  for (const [id, subject, status] of [[1, "AK-I repair — shipping it in", "open"], [2, "Where is my order?", "open"], [3, "Duo repair", "in_progress"]] as const) {
    env.DB.raw.prepare("INSERT INTO tickets (id, subject, customer_email, status, created_at, last_message_at) VALUES (?, ?, 'jane@example.com', ?, ?, ?)").run(id, subject, status, now, now);
  }
});

describe("ticket folders", () => {
  it("filing takes tickets out of the inbox and into the folder, searchable and counted", async () => {
    const { json } = await call("POST", "/folders", { name: "  Repairs —  waiting for machine " });
    expect(json.folder).toMatchObject({ id: 1, name: "Repairs — waiting for machine" });
    expect((await call("POST", "/folders", { name: "repairs — WAITING for machine" })).status).toBe(409);

    expect((await call("PATCH", "/tickets/1", { folder_id: 1 })).json.ticket.folder_id).toBe(1);
    await call("POST", "/tickets/bulk", { ids: [3], folder_id: 1 });
    expect(await ids("view=open")).toEqual([2]);
    expect(await ids("view=in_progress")).toEqual([]);
    expect((await ids("view=f:1")).sort()).toEqual([1, 3]);
    expect((await ids("view=all")).sort()).toEqual([1, 2, 3]);
    expect(await ids("view=open&q=AK-I")).toEqual([1]); // searching finds filed tickets
    const counts = (await call("GET", "/tickets/counts")).json;
    expect(counts).toMatchObject({ open: 1, in_progress: 0, "f:1": 2, "f:1:unread": 0 });
    const ev = env.DB.raw.prepare("SELECT kind, detail FROM events WHERE ticket_id = 1").all();
    expect(ev).toEqual([{ kind: "folder", detail: "Repairs — waiting for machine" }]);

    // Closed tickets leave the folder list (still filed), reopened ones come back with the unread mark
    env.DB.raw.prepare("UPDATE tickets SET status = 'closed' WHERE id = 3").run();
    expect(await ids("view=f:1")).toEqual([1]);
    env.DB.raw.prepare("UPDATE tickets SET unread = 1 WHERE id = 1").run();
    expect((await call("GET", "/tickets/counts")).json["f:1:unread"]).toBe(1);

    await call("PATCH", "/tickets/1", { folder_id: null });
    expect((await ids("view=open")).sort()).toEqual([1, 2]);
  });

  it("renaming, and removing a folder puts its tickets back in the inbox", async () => {
    await call("POST", "/folders", { name: "Repairs" });
    await call("PATCH", "/tickets/1", { folder_id: 1 });
    await call("PATCH", "/folders/1", { name: "Repairs in transit" });
    expect((await call("GET", "/folders")).json.folders).toEqual([{ id: 1, name: "Repairs in transit", position: 1 }]);
    expect((await call("DELETE", "/folders/1")).json).toEqual({ ok: true, returned: 1 });
    expect((await ids("view=open")).sort()).toEqual([1, 2]);
    expect((await call("PATCH", "/tickets/2", { folder_id: 99 })).status).toBe(404);
  });
});
