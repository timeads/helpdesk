import { describe, expect, it } from "vitest";
import { learnPacking, planOrders, productsKey, itemsKey } from "../src/lib/fulfillment";

// Minimal in-memory D1 stand-in for the few queries the planner and learner use
function fakeEnv() {
  const learned = new Map<string, any>();
  const presets = [
    { id: 1, name: "Standard", type: "box", length: 16, width: 12, height: 10, weight: 0.6, is_default: 1 },
    { id: 2, name: "Large", type: "box", length: 24, width: 18, height: 14, weight: 1.2, is_default: 0 },
  ];
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    async all() {
      if (sql.includes("FROM package_presets")) return { results: presets };
      if (sql.includes("FROM shipping_rules")) return { results: [] };
      if (sql.includes("WHERE item_key IN")) return { results: args.map((k) => learned.get(k)).filter(Boolean) };
      if (sql.includes("WHERE products_key IN")) return { results: [...learned.values()].filter((r) => args.includes(r.products_key)) };
      return { results: [] };
    },
    async first() { return null; },
    async run() {
      if (sql.startsWith("INSERT INTO learned_parcels")) {
        const [item_key, preset_id, length, width, height, weight, boxes, products_key, label] = args;
        const prev = learned.get(item_key);
        learned.set(item_key, { item_key, preset_id, length, width, height, weight, boxes, products_key, label, uses: (prev?.uses ?? 0) + 1, updated_at: new Date().toISOString() });
      }
      return { meta: { changes: 1 } };
    },
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as any, learned };
}

const lb = (v: number) => ({ id: "v", inventoryItem: { measurement: { weight: { value: v, unit: "POUNDS" } } } });
const order = (id: string, lines: [string, string, number, number][]) => ({
  id,
  lineItems: { nodes: lines.map(([lid, sku, quantity, w]) => ({ id: lid, sku, title: sku, variantTitle: null, quantity, variant: lb(w) })) },
}) as any;

describe("packing memory", () => {
  it("repeats a multi-box packing for the same items, box by box", async () => {
    const { env } = fakeEnv();
    const first = order("o1", [["l1", "GUN", 1, 4], ["l2", "CLOTH", 2, 3]]);
    await learnPacking(env, first, [
      { length: 16, width: 12, height: 10, weight: 5.1, presetId: 1, contents: [{ id: "l1", title: "GUN", qty: 1 }] },
      { length: 24, width: 18, height: 14, weight: 7.4, presetId: 2, contents: [{ id: "l2", title: "CLOTH", qty: 2 }] },
    ], null);
    // A later order: same items, different line ids and order
    const next = order("o2", [["x9", "CLOTH", 2, 3], ["x8", "GUN", 1, 4]]);
    const plan = (await planOrders(env, [next])).get("o2")!;
    expect(plan.source).toBe("learned");
    expect(plan.boxes.map((b) => b.preset?.name)).toEqual(["Standard", "Large"]);
    expect(plan.boxes[0].items).toEqual({ x8: 1 });
    expect(plan.boxes[1].items).toEqual({ x9: 2 });
    expect(plan.parcels.map((p) => p.weight)).toEqual([5.1, 7.4]);
    expect(plan.totalWeight).toBe(12.5);
  });

  it("reuses the box for the same products in other quantities, weighing from product weights", async () => {
    const { env } = fakeEnv();
    await learnPacking(env, order("o1", [["l1", "YARN", 4, 1]]), [{ length: 24, width: 18, height: 14, weight: 5, presetId: 2 }], null);
    const plan = (await planOrders(env, [order("o3", [["l7", "YARN", 6, 1]])])).get("o3")!;
    expect(plan.source).toBe("learned-similar");
    expect(plan.preset?.name).toBe("Large");
    expect(plan.parcel.weight).toBe(7.2); // 6 × 1 lb + 1.2 lb box
  });

  it("falls back to the default box for products it hasn't seen", async () => {
    const { env } = fakeEnv();
    const plan = (await planOrders(env, [order("o4", [["l1", "NEW", 1, 2]])])).get("o4")!;
    expect(plan.source).toBe("default");
    expect(plan.preset?.name).toBe("Standard");
    expect(plan.parcel.weight).toBe(2.6);
  });

  it("keys combine duplicate lines of the same product", () => {
    const a = order("a", [["l1", "YARN", 2, 1], ["l2", "YARN", 2, 1]]);
    expect(itemsKey(a)).toBe("yarn×4");
    expect(productsKey(a)).toBe("yarn");
  });
});
