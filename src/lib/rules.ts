// Shipping rules (ported from Redo automations): conditions on the order → suggested box / signature.
import type { ShopifyOrder } from "./shopify";

export interface RuleCondition {
  field: "item_quantity" | "product_names" | "product_skus" | "order_total" | "destination_state" | "destination_country" | "shipping_service";
  op: "eq" | "gt" | "lt" | "includes_any" | "excludes" | "contains";
  value: string;
}
export interface RuleAction {
  type: "set_package" | "require_signature" | "set_service" | "place_hold";
  value: string; // package name | "standard"/"adult" | "cheapest"/"fastest"/UPS service code | hold note
}

export const RULE_ACTIONS: RuleAction["type"][] = ["set_package", "require_signature", "set_service", "place_hold"];
export interface ShippingRule {
  id: number;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}
export interface RuleResult {
  packageName: string | null;
  signature: "standard" | "adult" | null;
  service: string | null; // "cheapest" | "fastest" | UPS service code
  hold: string | null; // note, when a rule holds the order
  matched: string[];
}

export const RULE_FIELDS: Record<RuleCondition["field"], { label: string; ops: RuleCondition["op"][] }> = {
  item_quantity: { label: "Items in order", ops: ["eq", "gt", "lt"] },
  order_total: { label: "Order total ($)", ops: ["gt", "lt", "eq"] },
  product_names: { label: "Product names", ops: ["includes_any", "excludes", "contains"] },
  product_skus: { label: "Product SKUs", ops: ["includes_any", "excludes", "contains"] },
  destination_state: { label: "Destination state", ops: ["includes_any", "excludes"] },
  destination_country: { label: "Destination country", ops: ["includes_any", "excludes"] },
  shipping_service: { label: "Requested shipping service", ops: ["includes_any", "contains", "excludes"] },
};

const list = (v: string) => v.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

function values(order: ShopifyOrder, field: RuleCondition["field"]): string[] | number {
  const lines = order.lineItems.nodes;
  switch (field) {
    case "item_quantity":
      return lines.reduce((n, l) => n + l.quantity, 0);
    case "order_total":
      return Number(order.totalPriceSet.shopMoney.amount);
    case "product_names":
      return lines.map((l) => l.title.toLowerCase());
    case "product_skus":
      return lines.map((l) => (l.sku ?? "").toLowerCase()).filter(Boolean);
    case "destination_state":
      return [String(order.shippingAddress?.provinceCode ?? "").toLowerCase()];
    case "destination_country":
      return [String(order.shippingAddress?.countryCodeV2 ?? "").toLowerCase()];
    case "shipping_service":
      return order.shippingLines.nodes.map((s) => s.title.toLowerCase());
  }
}

export function conditionMatches(order: ShopifyOrder, c: RuleCondition): boolean {
  const actual = values(order, c.field);
  if (typeof actual === "number") {
    const want = Number(c.value);
    if (Number.isNaN(want)) return false;
    return c.op === "eq" ? actual === want : c.op === "gt" ? actual > want : c.op === "lt" ? actual < want : false;
  }
  const wanted = list(c.value);
  switch (c.op) {
    case "includes_any": // an item equals or contains one of the listed values
      return actual.some((a) => wanted.some((w) => a === w || a.includes(w)));
    case "contains":
      return actual.some((a) => wanted.some((w) => a.includes(w)));
    case "excludes":
      return !actual.some((a) => wanted.some((w) => a === w || a.includes(w)));
    default:
      return false;
  }
}

/** First matching enabled rule wins for each kind of action. */
export function evaluateRules(order: ShopifyOrder, rules: ShippingRule[]): RuleResult {
  const out: RuleResult = { packageName: null, signature: null, service: null, hold: null, matched: [] };
  for (const r of rules) {
    if (!r.enabled || !r.conditions.length) continue;
    if (!r.conditions.every((c) => conditionMatches(order, c))) continue;
    let used = false;
    for (const a of r.actions) {
      if (a.type === "set_package" && !out.packageName && a.value) {
        out.packageName = a.value;
        used = true;
      }
      if (a.type === "require_signature" && !out.signature && (a.value === "standard" || a.value === "adult")) {
        out.signature = a.value;
        used = true;
      }
      if (a.type === "set_service" && !out.service && a.value) {
        out.service = a.value;
        used = true;
      }
      if (a.type === "place_hold" && out.hold === null) {
        out.hold = a.value || r.name;
        used = true;
      }
    }
    if (used) out.matched.push(r.name);
  }
  return out;
}
