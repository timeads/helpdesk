import { describe, it, expect } from "vitest";
import { buildHubCards, hubAuthStatus, hubPeriods, midnightNY, safeEqual, upOnly, type HubStats } from "../src/lib/hub-summary";
import { loadHubStats, hubSummary } from "../src/routes/hub-summary";
import { testD1 } from "./helpers/d1";

const at = (s: string) => new Date(s).getTime();
const isoOf = (ms: number) => new Date(ms).toISOString();
const TOKEN = "test-token-not-a-secret";

describe("hub auth", () => {
  it("is 503 when the token isn't set on the Worker", async () => {
    expect(await hubAuthStatus(undefined, `Bearer ${TOKEN}`)).toBe(503);
    expect(await hubAuthStatus("  ", `Bearer ${TOKEN}`)).toBe(503);
  });
  it("is 401 for a missing, malformed or wrong bearer", async () => {
    expect(await hubAuthStatus(TOKEN, undefined)).toBe(401);
    expect(await hubAuthStatus(TOKEN, TOKEN)).toBe(401);
    expect(await hubAuthStatus(TOKEN, "Bearer ")).toBe(401);
    expect(await hubAuthStatus(TOKEN, "Bearer nope")).toBe(401);
    expect(await hubAuthStatus(TOKEN, `Bearer ${TOKEN}x`)).toBe(401);
    expect(await hubAuthStatus(TOKEN, `Basic ${TOKEN}`)).toBe(401);
  });
  it("is 200 when it matches", async () => {
    expect(await hubAuthStatus(TOKEN, `Bearer ${TOKEN}`)).toBe(200);
    expect(await hubAuthStatus(TOKEN, `bearer  ${TOKEN} `)).toBe(200);
  });
  it("compares whole strings", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "ab")).toBe(false);
  });
});

describe("store-time weeks and months", () => {
  it("starts the week at Monday midnight Eastern", () => {
    // Thursday 22 Oct 2026, 2pm EDT
    const p = hubPeriods(at("2026-10-22T18:00:00Z"));
    expect(isoOf(p.weekStart)).toBe("2026-10-19T04:00:00.000Z");
    expect(isoOf(p.prevWeekStart)).toBe("2026-10-12T04:00:00.000Z");
    expect(isoOf(p.prevWeekUntil)).toBe("2026-10-15T18:00:00.000Z");
    expect(isoOf(p.monthStart)).toBe("2026-10-01T04:00:00.000Z");
    expect(isoOf(p.prevMonthStart)).toBe("2026-09-01T04:00:00.000Z");
    expect(isoOf(p.prevMonthUntil)).toBe("2026-09-22T18:00:00.000Z");
  });
  it("counts Sunday night in the week that began the Monday before", () => {
    // Sunday 25 Oct 2026, 11:30pm EDT = Monday 03:30 UTC
    expect(isoOf(hubPeriods(at("2026-10-26T03:30:00Z")).weekStart)).toBe("2026-10-19T04:00:00.000Z");
    // Monday 00:00 EDT exactly is the new week
    expect(isoOf(hubPeriods(at("2026-10-26T04:00:00Z")).weekStart)).toBe("2026-10-26T04:00:00.000Z");
  });
  it("handles the week clocks fall back (1 Nov 2026)", () => {
    // Monday 2 Nov 2026, 9am EST: this week starts in EST, last week in EDT
    const p = hubPeriods(at("2026-11-02T14:00:00Z"));
    expect(isoOf(p.weekStart)).toBe("2026-11-02T05:00:00.000Z");
    expect(isoOf(p.prevWeekStart)).toBe("2026-10-26T04:00:00.000Z");
    // Sunday 1 Nov, 11pm EST still belongs to the week of 26 Oct (EDT midnight)
    expect(isoOf(hubPeriods(at("2026-11-02T04:00:00Z")).weekStart)).toBe("2026-10-26T04:00:00.000Z");
    expect(isoOf(hubPeriods(at("2026-11-02T04:00:00Z")).monthStart)).toBe("2026-11-01T04:00:00.000Z");
  });
  it("handles the week clocks spring forward (8 Mar 2026) and the new year", () => {
    const p = hubPeriods(at("2026-03-10T12:00:00Z")); // Tuesday, EDT
    expect(isoOf(p.weekStart)).toBe("2026-03-09T04:00:00.000Z");
    expect(isoOf(p.prevWeekStart)).toBe("2026-03-02T05:00:00.000Z");
    const jan = hubPeriods(at("2027-01-01T12:00:00Z")); // Friday 1 Jan 2027
    expect(isoOf(jan.weekStart)).toBe("2026-12-28T05:00:00.000Z");
    expect(isoOf(jan.monthStart)).toBe("2027-01-01T05:00:00.000Z");
    expect(isoOf(jan.prevMonthStart)).toBe("2026-12-01T05:00:00.000Z");
  });
  it("caps last month's stretch at its end (31st vs a 30-day month)", () => {
    const p = hubPeriods(at("2026-10-31T20:00:00Z"));
    expect(p.prevMonthUntil).toBe(p.monthStart);
  });
  it("finds midnight on any day", () => {
    expect(isoOf(midnightNY(2026, 7, 4))).toBe("2026-07-04T04:00:00.000Z");
    expect(isoOf(midnightNY(2026, 12, 25))).toBe("2026-12-25T05:00:00.000Z");
    expect(isoOf(midnightNY(2026, 11, 0))).toBe("2026-10-31T04:00:00.000Z");
  });
});

describe("only up-trends", () => {
  it("shows a percentage only when ahead", () => {
    expect(upOnly(118, 100, "month")).toEqual({ detail: "Up 18% on last month at this point", trend: "up" });
    expect(upOnly(10, 10, "week")).toEqual({ detail: "Level with last week at this point", trend: "flat" });
  });
  it("says nothing when behind, new, or barely moved", () => {
    expect(upOnly(9, 10, "week")).toEqual({});
    expect(upOnly(5, 0, "week")).toEqual({});
    expect(upOnly(1001, 1000, "week")).toEqual({});
  });
});

const stats = (over: Partial<HubStats> = {}): HubStats => ({
  solvedWeek: 0, solvedPrevWeek: 0, firstReplyHours: [], chatsMonth: 0, chatsPrevMonth: 0, labelsWeek: 0, ...over,
});

describe("hub cards", () => {
  it("omits every card that would be zero", () => {
    expect(buildHubCards(stats())).toEqual([]);
  });
  it("never sends a down trend", () => {
    const cards = buildHubCards(stats({ solvedWeek: 5, solvedPrevWeek: 20, chatsMonth: 3, chatsPrevMonth: 9, labelsWeek: 4 }));
    expect(cards.map((c) => c.id)).toEqual(["tickets-solved-this-week", "chats-answered-this-month", "labels-this-week"]);
    for (const c of cards) {
      expect(c.trend).toBeUndefined();
      expect(c.detail).toBeUndefined();
    }
  });
  it("builds all four when there's good news", () => {
    const cards = buildHubCards(stats({ solvedWeek: 42, solvedPrevWeek: 30, firstReplyHours: [1, 2, 3.5, 30], chatsMonth: 12, chatsPrevMonth: 12, labelsWeek: 61 }));
    expect(cards).toEqual([
      { id: "tickets-solved-this-week", label: "Tickets solved this week", value: 42, unit: "count", detail: "Up 40% on last week at this point", trend: "up", href: "https://help.tuftlife.com/dashboard" },
      { id: "first-reply-this-week", label: "Typical first reply this week", value: 2.8, unit: "hours", detail: "Median across 4 emails answered", href: "https://help.tuftlife.com/dashboard" },
      { id: "chats-answered-this-month", label: "Live chats answered this month", value: 12, unit: "count", detail: "Level with last month at this point", trend: "flat", href: "https://help.tuftlife.com/dashboard" },
      { id: "labels-this-week", label: "Shipping labels bought this week", value: 61, unit: "count", href: "https://help.tuftlife.com/shipping" },
    ]);
    for (const c of cards) expect(typeof c.value).toBe("number");
  });
  it("shows first reply in minutes under an hour, and only when it's a real win", () => {
    expect(buildHubCards(stats({ firstReplyHours: [0.25, 0.5, 0.75] }))[0]).toMatchObject({ value: 30, unit: "minutes" });
    expect(buildHubCards(stats({ firstReplyHours: [0.001, 0.002, 0.003] }))[0]).toMatchObject({ value: 1, unit: "minutes" });
    expect(buildHubCards(stats({ firstReplyHours: [1, 2] }))).toEqual([]); // too few to say
    expect(buildHubCards(stats({ firstReplyHours: [30, 40, 50] }))).toEqual([]); // slow week: not a win
  });
});

describe("hub summary queries", () => {
  it("counts this week and month in store time from real tables", async () => {
    const db = testD1();
    const p = hubPeriods(at("2026-10-22T18:00:00Z"));
    db.raw.exec(`
      INSERT INTO agents (id, email, name, role) VALUES (1, 'a@x.com', 'A', 'agent');
      INSERT INTO tickets (id, subject, customer_email, status, created_at, last_message_at, closed_at, channel) VALUES
        (1, 's', 'c@x.com', 'closed',   '2026-10-19T10:00:00.000Z', '2026-10-19T12:00:00.000Z', '2026-10-20T12:00:00.000Z', 'email'),
        (2, 's', 'c@x.com', 'archived', '2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-21T12:00:00.000Z', 'email'),
        (3, 's', 'c@x.com', 'closed',   '2026-10-12T10:00:00.000Z', '2026-10-12T12:00:00.000Z', '2026-10-13T12:00:00.000Z', 'email'),
        (4, 's', 'c@x.com', 'closed',   '2026-10-12T10:00:00.000Z', '2026-10-12T12:00:00.000Z', '2026-10-17T12:00:00.000Z', 'email'),
        (5, 's', 'c@x.com', 'closed',   '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', '2026-10-19T03:59:00.000Z', 'email'),
        (6, 's', 'c@x.com', 'open',     '2026-10-21T10:00:00.000Z', '2026-10-21T12:00:00.000Z', NULL, 'chat'),
        (7, 's', 'c@x.com', 'open',     '2026-09-05T10:00:00.000Z', '2026-09-05T12:00:00.000Z', NULL, 'chat'),
        (8, 's', 'c@x.com', 'open',     '2026-10-21T10:00:00.000Z', '2026-10-21T12:00:00.000Z', NULL, 'chat');
      INSERT INTO messages (ticket_id, direction, from_email, sent_at, agent_id, kind) VALUES
        (1, 'out', 'us@x.com', '2026-10-19T11:00:00.000Z', NULL, NULL),
        (1, 'out', 'us@x.com', '2026-10-19T12:00:00.000Z', 1, NULL),
        (2, 'out', 'us@x.com', '2026-10-20T10:30:00.000Z', 1, NULL),
        (6, 'out', 'ai@chat', '2026-10-21T10:01:00.000Z', NULL, 'chat_ai'),
        (7, 'out', 'agent@chat', '2026-09-05T10:05:00.000Z', 1, 'chat'),
        (8, 'out', 'system@chat', '2026-10-21T10:01:00.000Z', NULL, 'chat_system');
      INSERT INTO chats (id, token, ticket_id, email, created_at) VALUES
        ('c6', 't', 6, 'c@x.com', '2026-10-21T10:00:00.000Z'),
        ('c7', 't', 7, 'c@x.com', '2026-09-05T10:00:00.000Z'),
        ('c8', 't', 8, 'c@x.com', '2026-10-21T10:00:00.000Z');
      INSERT INTO shipments (order_id, order_name, tracking_numbers, service_code, service_name, cost, packages, status, created_at) VALUES
        ('o1', '#1', '1Z1', '03', 'Ground', 10, '[{"w":1},{"w":2}]', 'purchased', '2026-10-20T15:00:00.000Z'),
        ('o2', '#2', '1Z2', '03', 'Ground', 10, '[]', 'purchased', '2026-10-21T15:00:00.000Z'),
        ('o3', '#3', '1Z3', '03', 'Ground', 10, '[{"w":1}]', 'voided', '2026-10-21T15:00:00.000Z'),
        ('o4', '#4', '1Z4', '03', 'Ground', 10, '[{"w":1}]', 'purchased', '2026-10-19T03:00:00.000Z');
    `);
    const s = await loadHubStats(db as unknown as D1Database, p);
    expect(s.solvedWeek).toBe(2); // ticket 5 closed Sunday 11:59pm ET, last week
    expect(s.solvedPrevWeek).toBe(1); // ticket 4 closed after "this point" last week
    expect(s.firstReplyHours.map((h) => Math.round(h * 100) / 100)).toEqual([2, 0.5]); // automatic reply on ticket 1 skipped
    expect(s.chatsMonth).toBe(1); // a status line isn't an answer
    expect(s.chatsPrevMonth).toBe(1);
    expect(s.labelsWeek).toBe(3);
  });
});

describe("hub summary route", () => {
  const call = async (env: Record<string, unknown>, auth?: string) => {
    let out: { body: unknown; status: number; headers?: Record<string, string> } | undefined;
    const c = {
      env,
      req: { header: (n: string) => (n.toLowerCase() === "authorization" ? auth : undefined) },
      json: (body: unknown, status: number, headers?: Record<string, string>) => ((out = { body, status, headers }), out),
    };
    await hubSummary(c as any);
    return out!;
  };
  it("answers 503, 401, then cards", async () => {
    const db = testD1();
    expect(await call({ DB: db })).toMatchObject({ status: 503, body: { error: "not configured" } });
    expect(await call({ DB: db, HUB_SUMMARY_TOKEN: TOKEN }, "Bearer wrong")).toMatchObject({ status: 401 });
    const ok = await call({ DB: db, HUB_SUMMARY_TOKEN: TOKEN }, `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.headers).toEqual({ "cache-control": "no-store" });
    expect(ok.body).toMatchObject({ app: "help", cards: [] });
    expect((ok.body as any).generatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
  it("hides internal errors", async () => {
    const broken = { prepare: () => { throw new Error("secret detail"); } };
    const r = await call({ DB: broken, HUB_SUMMARY_TOKEN: TOKEN }, `Bearer ${TOKEN}`);
    expect(r).toMatchObject({ status: 500, body: { error: "summary unavailable" } });
  });
});
