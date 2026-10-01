import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRateRequest, buildShipRequest, parseShipResponse } from "../src/lib/ups";
import { buyUsps } from "../src/lib/easypost";
import { cleanCustoms, customsProblems, type Customs } from "../src/lib/customs";

const from = { name: "Tuft HQ", phone: "2155550100", address1: "5400 Grays Ave", city: "Philadelphia", state: "PA", zip: "19143", country: "US" };
const toCA = { name: "Ana Costa", phone: "4165550100", address1: "1 Queen St W", city: "Toronto", state: "ON", zip: "M5H 2N2", country: "CA", residential: true };
const customs: Customs = {
  contents: "merchandise", dutiesPaidBy: "recipient", nonDelivery: "return", signer: "Tim Eads",
  items: [
    { productKey: "yarn", lineId: "l1", description: "Acrylic yarn", hsCode: "550931", origin: "US", qty: 4, unitValue: 12.5, unitWeightLb: 0.5 },
    { productKey: "gun", lineId: "l2", description: "Tufting gun", hsCode: "846729", origin: "CN", qty: 1, unitValue: 189, unitWeightLb: 4 },
  ],
};
const box = { length: 16, width: 12, height: 10, weight: 7 };

describe("UPS international", () => {
  it("adds the invoice total for Canada when rating, and drops US-only signature", () => {
    const r = buildRateRequest("A1B2C3", from, toCA, [box], "standard", customs).RateRequest.Shipment as any;
    expect(r.InvoiceLineTotal).toEqual({ CurrencyCode: "USD", MonetaryValue: "239" });
    expect(r.Package[0].PackageServiceOptions).toBeUndefined();
  });

  it("builds a commercial invoice with each item, and bills duties to us when chosen", () => {
    const req = buildShipRequest("A1B2C3", from, toCA, [box], "11", { labelFormat: "GIF", customs: { ...customs, dutiesPaidBy: "sender" } }) as any;
    const sh = req.ShipmentRequest.Shipment;
    const forms = sh.ShipmentServiceOptions.InternationalForms;
    expect(forms.FormType).toBe("01");
    expect(forms.ReasonForExport).toBe("SALE");
    expect(forms.Product[1]).toMatchObject({ Description: ["Tufting gun"], CommodityCode: "846729", OriginCountryCode: "CN", Unit: { Number: "1", Value: "189.00" } });
    expect(sh.PaymentInformation.ShipmentCharge.map((c: any) => c.Type)).toEqual(["01", "02"]);
  });

  it("refuses international without customs or a phone number", () => {
    expect(() => buildShipRequest("A1B2C3", from, toCA, [box], "11", { labelFormat: "GIF" })).toThrow(/customs/);
    expect(() => buildShipRequest("A1B2C3", from, { ...toCA, phone: "" }, [box], "11", { labelFormat: "GIF", customs })).toThrow(/phone/);
  });

  it("returns the invoice PDF with the label", () => {
    const r = parseShipResponse({ ShipmentResponse: { ShipmentResults: {
      ShipmentIdentificationNumber: "1ZX", PackageResults: { TrackingNumber: "1ZX", ShippingLabel: { GraphicImage: "R0lG" } },
      ShipmentCharges: { TotalCharges: { MonetaryValue: "48.20", CurrencyCode: "USD" } },
      Form: { Image: { ImageFormat: { Code: "PDF" }, GraphicImage: "JVBERi0" } },
    } } });
    expect(r.forms).toEqual([{ type: "Commercial invoice", data: "JVBERi0" }]);
  });
});

describe("USPS international (EasyPost)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends a customs list per box and downloads the customs form", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/orders")) return new Response(JSON.stringify({ id: "order_1", rates: [{ id: "r", carrier: "USPS", service: "PriorityMailInternational", rate: "61.40" }] }));
      if (url.endsWith("/buy")) return new Response(JSON.stringify({ shipments: [
        { id: "a", tracking_code: "LA1", selected_rate: { rate: "31" }, postage_label: { label_url: "https://f/a.png" }, forms: [{ form_type: "commercial_invoice", form_url: "https://f/a.pdf" }] },
        { id: "b", tracking_code: "LA2", selected_rate: { rate: "30.4" }, postage_label: { label_url: "https://f/b.png" } },
      ] }));
      return new Response(new Uint8Array([37, 80, 68, 70]));
    }));
    const parcels = [
      { ...box, contents: [{ id: "l1", title: "Yarn", qty: 4 }] },
      { ...box, contents: [{ id: "l2", title: "Gun", qty: 1 }] },
    ];
    const r = await buyUsps({ EASYPOST_API_KEY: "EZAK" } as any, from, toCA, parcels, "usps:PriorityMailInternational", { labelFormat: "GIF", customs });
    const shipments = calls[0].body.order.shipments;
    expect(shipments[0].customs_info.customs_items).toEqual([expect.objectContaining({ description: "Acrylic yarn", quantity: 4, value: 50, weight: 32, hs_tariff_number: "550931" })]);
    expect(shipments[1].customs_info.customs_items[0]).toMatchObject({ description: "Tufting gun", quantity: 1, value: 189, origin_country: "CN" });
    expect(shipments[0].customs_info).toMatchObject({ customs_signer: "Tim Eads", eel_pfc: "NOEEI 30.37(a)", non_delivery_option: "return" });
    expect(shipments[0].options.delivery_confirmation).toBeUndefined();
    expect(r.forms).toHaveLength(1);
    expect(r.trackingNumbers).toEqual(["LA1", "LA2"]);
  });
});

describe("customs checks", () => {
  it("flags missing descriptions, bad HS codes and the $2,500 export-filing line", () => {
    const c = cleanCustoms({ ...customs, items: [{ ...customs.items[0], description: "" }, { ...customs.items[1], hsCode: "12", qty: 14 }] })!;
    const p = customsProblems(c);
    expect(p.some((x) => /needs a description/.test(x))).toBe(true);
    expect(p.some((x) => /HS code should be/.test(x))).toBe(true);
    expect(p.some((x) => /export filing/.test(x))).toBe(true); // 14 × $189 = $2,646
    expect(customsProblems(customs)).toEqual([]);
  });
});
