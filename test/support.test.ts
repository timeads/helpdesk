import { describe, expect, it } from "vitest";
import { conditionMatches, parseTags, type TicketRow } from "../src/lib/support";
import { renderMacro } from "../src/lib/macros";

const ticket = (over: Partial<TicketRow> = {}): TicketRow => ({
  id: 1, subject: "Where is my order?", customer_email: "jane@example.com", customer_name: "Jane Doe", status: "open",
  priority: null, assignee_id: null, tags: '["VIP"]', message_count: 2, gmail_thread_id: "t1", ...over,
});
const msg = { from: "jane@example.com", subject: "Where is my order?", body: "My tufting gun is jammed and not cutting" };

describe("support rule conditions", () => {
  it("matches any of comma-separated words", () => {
    expect(conditionMatches({ field: "body", op: "contains", value: "broken, jammed" }, { ticket: ticket(), message: msg })).toBe(true);
    expect(conditionMatches({ field: "body", op: "not_contains", value: "refund" }, { ticket: ticket(), message: msg })).toBe(true);
  });
  it("matches sender domains", () => {
    expect(conditionMatches({ field: "from", op: "is", value: "@example.com" }, { ticket: ticket(), message: msg })).toBe(true);
    expect(conditionMatches({ field: "from", op: "is_not", value: "@example.com" }, { ticket: ticket(), message: msg })).toBe(false);
  });
  it("checks tags case-insensitively, status, assignment and counts", () => {
    expect(conditionMatches({ field: "has_tag", op: "is", value: "vip" }, { ticket: ticket(), message: null })).toBe(true);
    expect(conditionMatches({ field: "status", op: "is", value: "open, in_progress" }, { ticket: ticket(), message: null })).toBe(true);
    expect(conditionMatches({ field: "assigned", op: "is", value: "no" }, { ticket: ticket(), message: null })).toBe(true);
    expect(conditionMatches({ field: "message_count", op: "gt", value: "1" }, { ticket: ticket(), message: null })).toBe(true);
  });
  it("parses stored tags defensively", () => {
    expect(parseTags("not json")).toEqual([]);
    expect(parseTags('["a","b"]')).toEqual(["a", "b"]);
  });
});

describe("macro variables", () => {
  it("fills customer, agent and order fields", () => {
    const out = renderMacro("Hi {{customer.first_name}}, {{order.number}} ships via {{order.tracking_url}}. — {{agent.first_name}}", {
      customer: { name: "Jane Doe" }, agent: { name: "Tim Eads" }, order: { name: "#1042", trackingUrl: "https://ups.com/x" },
    });
    expect(out).toBe("Hi Jane, #1042 ships via https://ups.com/x. — Tim");
  });
  it("keeps the old short forms and leaves unknown variables visible", () => {
    expect(renderMacro("Hi {{first_name}} {{nope}}", { customer: { name: "" } })).toBe("Hi there {{nope}}");
  });
});
