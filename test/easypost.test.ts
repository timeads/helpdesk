import { afterEach, describe, expect, it, vi } from "vitest";
import { buyUsps, getUspsRates, refundUsps } from "../src/lib/easypost";
import { getAllRates } from "../src/lib/carriers";

const env = { EASYPOST_API_KEY: "EZAKtest" } as any;
const from = { name: "Tuft HQ", phone: "2155550100", address1: "5400 Grays Ave", city: "Philadelphia", state: "PA", zip: "19143", country: "US" };
const to = { name: "Jane", address1: "1 Main St", city: "Austin", state: "TX", zip: "78701", country: "US", residential: true };
const box = { length: 16, width: 12, height: 10, weight: 5.25 };
const rates = [
  { id: "rate_ga", carrier: "USPS", service: "GroundAdvantage", rate: "7.58", retail_rate: "11.25", currency: "USD", delivery_days: 4 },
  { id: "rate_pm", carrier: "USPS", service: "Priority", rate: "10.40", retail_rate: "14.10", currency: "USD", delivery_days: 2 },
  { id: "rate_x", carrier: "USPS", service: "Unknown", rate: "1", currency: "USD" },
];

function mockFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; body: any; auth: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization });
    const out = handler(url, init);
    if (out instanceof Uint8Array) return new Response(out);
    return new Response(JSON.stringify(out), { status: out?.__status ?? 200 });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("USPS via EasyPost", () => {
  it("quotes USPS services in ounces with the key as basic auth", async () => {
    const calls = mockFetch(() => ({ id: "shp_1", rates }));
    const r = await getUspsRates(env, from, to, [box], "standard");
    expect(r.map((x) => x.serviceCode)).toEqual(["usps:GroundAdvantage", "usps:Priority"]);
    expect(r[0]).toMatchObject({ carrier: "USPS", serviceName: "USPS Ground Advantage", total: 7.58, listTotal: 11.25, days: 4 });
    expect(calls[0].url).toBe("https://api.easypost.com/v2/shipments");
    expect(calls[0].auth).toBe(`Basic ${btoa("EZAKtest:")}`);
    expect(calls[0].body.shipment.parcel.weight).toBe(84); // 5.25 lb
    expect(calls[0].body.shipment.options.delivery_confirmation).toBe("SIGNATURE");
  });

  it("doesn't quote USPS outside the US yet", async () => {
    mockFetch(() => { throw new Error("should not call"); });
    expect(await getUspsRates(env, from, { ...to, country: "CA" }, [box])).toEqual([]);
  });

  it("buys one box: picks the matching rate and downloads the PNG label", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/shipments")) return { id: "shp_1", rates };
      if (url.endsWith("/shipments/shp_1/buy")) return { id: "shp_1", tracking_code: "9400111", selected_rate: { rate: "7.58", currency: "USD" }, postage_label: { label_url: "https://files.example/l.png" } };
      if (url.startsWith("https://files.example")) return new Uint8Array([137, 80, 78, 71]);
      throw new Error(url);
    });
    const r = await buyUsps(env, from, to, [box], "usps:GroundAdvantage", { labelFormat: "GIF", reference: "#1042" });
    expect(calls[1].body).toEqual({ rate: { id: "rate_ga" } });
    expect(r).toMatchObject({ shipmentId: "ep:shp_1", trackingNumbers: ["9400111"], cost: 7.58, format: "PNG" });
    expect(r.labels[0]).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
  });

  it("buys several boxes as one EasyPost order, a label per box", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/orders")) return { id: "order_1", rates };
      if (url.endsWith("/orders/order_1/buy")) return { shipments: [
        { id: "shp_a", tracking_code: "9400A", selected_rate: { rate: "7.10" }, postage_label: { label_zpl_url: "https://files.example/a.zpl" } },
        { id: "shp_b", tracking_code: "9400B", selected_rate: { rate: "6.90" }, postage_label: { label_zpl_url: "https://files.example/b.zpl" } },
      ] };
      if (url.startsWith("https://files.example")) return new TextEncoder().encode("^XA^XZ");
      throw new Error(url);
    });
    const r = await buyUsps(env, from, to, [box, box], "usps:GroundAdvantage", { labelFormat: "ZPL" });
    expect(calls[0].body.order.shipments).toHaveLength(2);
    expect(calls[1].body).toEqual({ carrier: "USPS", service: "GroundAdvantage" });
    expect(r).toMatchObject({ shipmentId: "ep:shp_a,shp_b", trackingNumbers: ["9400A", "9400B"], cost: 14, format: "ZPL" });
    expect(r.labels).toHaveLength(2);
  });

  it("refunds every label of a shipment", async () => {
    const calls = mockFetch(() => ({ refund_status: "submitted" }));
    await refundUsps(env, "ep:shp_a,shp_b");
    expect(calls.map((c) => c.url)).toEqual(["https://api.easypost.com/v2/shipments/shp_a/refund", "https://api.easypost.com/v2/shipments/shp_b/refund"]);
  });

  it("still shows USPS rates when UPS isn't connected or fails", async () => {
    mockFetch(() => ({ id: "shp_1", rates }));
    const r = await getAllRates({ ...env, UPS_CLIENT_ID: "x", UPS_CLIENT_SECRET: "y", UPS_ACCOUNT_NUMBER: "z", DB: { prepare: () => { throw new Error("no ups token"); } } } as any, from, to, [box]);
    expect(r.map((x) => x.carrier)).toEqual(["USPS", "USPS"]);
  });
});
