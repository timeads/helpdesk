import { afterEach, describe, expect, it, vi } from "vitest";
import { buyEasypost, getEasypostRates } from "../src/lib/easypost";
import { carrierOf, purchase, trackingUrlFor } from "../src/lib/carriers";

const env = { EASYPOST_API_KEY: "EZAKtest" } as any;
const from = { name: "Tuft HQ", phone: "2155550100", address1: "5400 Grays Ave", city: "Philadelphia", state: "PA", zip: "19143", country: "US" };
const to = { name: "Jane", address1: "1 Main St", city: "Austin", state: "TX", zip: "78701", country: "US", residential: true };
const box = { length: 16, width: 12, height: 10, weight: 5.25 };
const rates = [
  { id: "r1", carrier: "USPS", service: "GroundAdvantage", rate: "9.10", delivery_days: 4 },
  { id: "r2", carrier: "FedEx", service: "FEDEX_GROUND", rate: "8.40", delivery_days: 3 },
  { id: "r3", carrier: "FedEx", service: "FEDEX_GROUND", rate: "8.95", delivery_days: 3 }, // second FedEx account: the cheaper one wins
  { id: "r4", carrier: "UPSDAP", service: "Ground", rate: "8.70", delivery_days: 3 },
  { id: "r5", carrier: "OnTrac", service: "GRND", rate: "7.25", delivery_days: 2 },
  { id: "r6", carrier: "DhlEcs", service: "DHLParcelGround", rate: "7.90", delivery_days: 5 },
];

function mockFetch(handler: (url: string) => any) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const out = handler(url);
    return out instanceof Uint8Array ? new Response(out) : new Response(JSON.stringify(out));
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("every EasyPost carrier", () => {
  it("quotes all carriers with readable names, cheapest account per service", async () => {
    mockFetch(() => ({ id: "shp_1", rates }));
    const r = await getEasypostRates(env, from, to, [box]);
    expect(r.map((x) => [x.carrier, x.serviceCode, x.serviceName, x.total])).toEqual([
      ["OnTrac", "ep:OnTrac:GRND", "OnTrac Ground", 7.25],
      ["DHL eCommerce", "ep:DhlEcs:DHLParcelGround", "DHL eCommerce Parcel Ground", 7.9],
      ["FedEx", "ep:FedEx:FEDEX_GROUND", "FedEx Ground", 8.4],
      ["UPS", "ep:UPSDAP:Ground", "UPS Ground · EasyPost", 8.7],
      ["USPS", "usps:GroundAdvantage", "USPS Ground Advantage", 9.1],
    ]);
  });

  it("buys a FedEx label with that rate and reports FedEx as the carrier", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/shipments")) return { id: "shp_1", rates };
      if (url.endsWith("/buy")) return { id: "shp_1", tracking_code: "7712", selected_rate: { rate: "8.40" }, postage_label: { label_url: "https://files.example/l.png" } };
      return new Uint8Array([1, 2, 3]);
    });
    const r = await purchase(env, from, to, [box], "ep:FedEx:FEDEX_GROUND", { labelFormat: "GIF" });
    expect(calls[1].body).toEqual({ rate: { id: "r2" } });
    expect(r).toMatchObject({ carrier: "FedEx", shipmentId: "ep:shp_1", trackingNumbers: ["7712"], cost: 8.4 });
  });

  it("buys a split order from one carrier by carrier + service", async () => {
    const calls = mockFetch((url) => {
      if (url.endsWith("/orders")) return { id: "order_1", rates, shipments: [{ rates }, { rates }] };
      if (url.endsWith("/buy")) return { shipments: [{ id: "a", tracking_code: "A", selected_rate: { rate: "7" } }, { id: "b", tracking_code: "B", selected_rate: { rate: "7.5" } }] };
      return {};
    });
    const r = await buyEasypost(env, from, to, [box, box], "ep:OnTrac:GRND", { labelFormat: "GIF" });
    expect(calls[1].body).toEqual({ carrier: "OnTrac", service: "GRND" });
    expect(r.carrier).toBe("OnTrac");
    expect(r.perBox).toEqual([7, 7.5]);
  });

  it("names carriers and tracking pages", () => {
    expect(carrierOf("ep:FedEx:FEDEX_GROUND")).toBe("FedEx");
    expect(carrierOf("usps:Priority")).toBe("USPS");
    expect(carrierOf("03")).toBe("UPS");
    expect(trackingUrlFor("FedEx", "7712")).toBe("https://www.fedex.com/fedextrack/?trknbr=7712");
    expect(trackingUrlFor("OnTrac", "D100")).toContain("ontrac.com");
  });
});
