import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { testD1 } from "./helpers/d1";

const bought = vi.hoisted(() => ({ inputs: [] as any[] }));
vi.mock("../src/lib/fulfillment", async (orig) => ({
  ...(await orig<typeof import("../src/lib/fulfillment")>()),
  buyLabel: vi.fn(async (env: any, _agent: unknown, input: any) => {
    bought.inputs.push(input);
    const r = await env.DB.prepare("INSERT INTO shipments (order_id, order_name, carrier, service_code, service_name, shipment_id, tracking_numbers, cost, status, fulfilled) VALUES (?, ?, 'UPS', '03', 'UPS Ground', 'S1', '[\"1ZX\"]', 14.2, 'purchased', 1) RETURNING id")
      .bind(input.order.id, input.order.name).first();
    return { id: r.id, carrier: "UPS", trackingNumbers: ["1ZX"], cost: 14.2, currency: "USD", fulfillError: null };
  }),
}));
vi.mock("../src/lib/carriers", async (orig) => ({ ...(await orig<typeof import("../src/lib/carriers")>()), voidLabel: vi.fn(async () => {}) }));

import shipping from "../src/routes/shipping";
import { HttpError } from "../src/lib/util";

let env: any;
const app = new Hono<any>();
app.use(async (c, next) => { c.set("agent", { id: 1, name: "Tim" }); await next(); });
app.route("/", shipping);
app.onError((err, c) => c.json({ error: err.message }, err instanceof HttpError ? (err.status as any) : 500));
const call = async (path: string, body?: unknown) => {
  const r = await app.request(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  return { status: r.status, json: (await r.json()) as any };
};
const JANE = ["gid://shopify/Order/9042", "gid://shopify/Order/9055"];
const to = { name: "Jane Doe", address1: "100 Example St", city: "Austin", state: "TX", zip: "78701", country: "US", residential: true };

beforeEach(() => {
  env = { DB: testD1(), DEMO_DATA: "1" };
  env.DB.raw.prepare("INSERT INTO agents (id, email, name) VALUES (1, 'tim@x.com', 'Tim')").run();
  bought.inputs.length = 0;
});

describe("shipping orders together from the order page", () => {
  it("opens the group as one order with every item, saving choices under the group", async () => {
    const { json } = await call(`/merge/order?ids=${JANE.join(",")}`);
    expect(json.order).toMatchObject({ id: JANE[0], name: "#1042 + #1055-TG", merge: { ids: JANE, names: ["#1042", "#1055-TG"], key: `merge:${[...JANE].sort().join(",")}` } });
    expect(json.order.lineItems.nodes.map((l: any) => l.fromOrder)).toEqual(["#1042", "#1042", "#1055-TG"]);
    expect((await call(`/merge/order?ids=${JANE[0]},gid://shopify/Order/9050`)).status).toBe(409); // a different address
  });

  it("buys one label with the boxes as packed, marks every order shipped, and voiding undoes them all", async () => {
    const parcels = [{ length: 16, width: 12, height: 10, weight: 5, contents: [{ id: "gid://shopify/LineItem/251", title: "Gun", qty: 1 }] }, { length: 12, width: 10, height: 6, weight: 4 }];
    const r = await call("/labels", { orderId: JANE[0], mergeIds: [JANE[1]], to, parcels, serviceCode: "03", serviceName: "UPS Ground", fulfill: true, notifyCustomer: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ orderName: "#1042 + #1055-TG", fulfillError: null });
    expect(bought.inputs[0].parcels).toHaveLength(2);
    expect(bought.inputs[0].order.lineItems.nodes).toHaveLength(3);
    const q = (await call("/queue")).json;
    expect(q.orders.filter((o: any) => JANE.includes(o.id)).map((o: any) => o.hasLabel)).toEqual([true, true]);
    expect(q.merges).toEqual([]);
    expect((await call(`/labels/${r.json.id}/void`, {})).json).toMatchObject({ merged: 1 });
    expect((await call("/queue")).json.orders.filter((o: any) => JANE.includes(o.id)).map((o: any) => o.hasLabel)).toEqual([false, false]);
  });

  it("won't ship part of an order while shipping orders together", async () => {
    const r = await call("/labels", { orderId: JANE[0], mergeIds: [JANE[1]], to, parcels: [{ length: 1, width: 1, height: 1, weight: 1 }], serviceCode: "03", serviceName: "UPS Ground", partial: [{ id: "x", qty: 0 }] });
    expect(r.status).toBe(400);
  });
});
