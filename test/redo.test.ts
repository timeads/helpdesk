import { beforeEach, describe, expect, it, vi } from "vitest";
import { buyRedo, getRedoRates, literal, parseRedoCode, redoSchema, redoServiceName, redoSignatureWatch, sniffLabel, voidRedo } from "../src/lib/redo";
import { testD1 } from "./helpers/d1";
import { getAllRates, purchase, voidLabel } from "../src/lib/carriers";

const env: any = { REDO_API_TOKEN: "tok", REDO_STORE_ID: "6883aef0ba0eed4c392301a2" };
const from = { name: "Tuft the World", address1: "1901 S 9th St", city: "Philadelphia", state: "PA", zip: "19148", country: "US", phone: "215-555-0100" };
const to = { name: "Jane Doe", address1: "1 Elm St", address2: "Apt 2", city: "Austin", state: "TX", zip: "78701", country: "US" };
const box = (w: number) => ({ length: 12, width: 10, height: 6, weight: w });
const rate = (carrier: string, service: string, amount: string, acct = "ca_1") => ({ carrier, service, carrierAccountId: acct, rate: { amount, currency: "USD" }, deliveryDays: 3 });

let queries: string[];
let answer: (q: string) => any;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

beforeEach(() => {
  queries = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    if (String(url).startsWith("https://files.redo.example/")) return new Response(PDF);
    expect(url).toBe("https://api.getredo.com/v3/account/6883aef0ba0eed4c392301a2/graphql");
    expect(init.headers.authorization).toBe("Bearer tok");
    const q = JSON.parse(init.body).query as string;
    queries.push(q);
    return new Response(JSON.stringify(answer(q)), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

describe("Redo labels", () => {
  it("writes GraphQL input literals with bare enums", () => {
    expect(literal({ a: "x\"y", n: 2.5, list: [1, 2], skip: undefined, ok: true })).toBe('{a: "x\\"y" n: 2.5 list: [1 2] ok: true}');
    expect(redoServiceName("USPS", "GroundAdvantage")).toBe("USPS Ground Advantage · Redo");
    expect(redoServiceName("UPS", "UPS_2ND_DAY_AIR")).toBe("UPS 2nd Day Air · Redo");
  });

  it("quotes one box: every carrier Redo returns, as rates the order page can pick", async () => {
    answer = () => ({ data: { getShippingLabelQuotes: { rates: [rate("USPS", "GroundAdvantage", "8.15"), rate("UPS", "Ground", "11.20", "ca_ups")], messages: [] } } });
    const rates = await getRedoRates(env, from, to, [box(3)]);
    expect(queries[0]).toContain("getShippingLabelQuotes(input:");
    expect(queries[0]).toContain('toAddress: {name: "Jane Doe" street1: "1 Elm St" street2: "Apt 2" city: "Austin" state: "TX" zip: "78701" country: "US"}');
    expect(queries[0]).toContain("weight: {unit: POUND value: 3} length: {unit: INCH value: 12}");
    expect(rates).toEqual([
      { carrier: "USPS", serviceCode: "redo:1:ca_1:USPS:GroundAdvantage", serviceName: "USPS Ground Advantage · Redo", total: 8.15, listTotal: 8.15, currency: "USD", days: 3 },
      { carrier: "UPS", serviceCode: "redo:1:ca_ups:UPS:Ground", serviceName: "UPS Ground · Redo", total: 11.2, listTotal: 11.2, currency: "USD", days: 3 },
    ]);
    await getRedoRates(env, from, { ...to, company: "Acme Studio" }, [box(3)]);
    expect(queries.at(-1)).toContain('toAddress: {name: "Jane Doe, Acme Studio" street1:');
    expect(queries.at(-1)).not.toContain("company:");
    expect(parseRedoCode(rates[0].serviceCode)).toEqual({ mode: "1", carrierAccountId: "ca_1", carrier: "USPS", service: "GroundAdvantage" });
  });

  it("several boxes: UPS/FedEx as one shipment, other carriers box by box and added up", async () => {
    answer = (q) => {
      const boxes = (q.match(/weight: \{/g) ?? []).length;
      if (boxes === 2) return { data: { getShippingLabelQuotes: { rates: [rate("UPS", "Ground", "19.00", "ca_ups")] } } };
      const heavy = q.includes("value: 5}");
      return { data: { getShippingLabelQuotes: { rates: [rate("USPS", "GroundAdvantage", heavy ? "12.00" : "7.50"), ...(heavy ? [] : [rate("USPS", "Priority", "9.00")])] } } };
    };
    const rates = await getRedoRates(env, from, to, [box(2), box(5)]);
    expect(rates.map((r) => [r.serviceCode, r.total, r.perBox ?? null])).toEqual([
      ["redo:1:ca_ups:UPS:Ground", 19, null],
      ["redo:n:ca_1:USPS:GroundAdvantage", 19.5, [7.5, 12]], // Priority wasn't offered for the heavy box: left out
    ]);
  });

  it("buys with the same request, keeps the PDF label, and voids the boxes already bought if one fails", async () => {
    let buys = 0;
    answer = (q) => {
      if (q.includes("voidCarrierShipment")) return { data: { voidCarrierShipment: { shipmentId: "sh_1", refundStatus: null } } };
      buys++;
      if (buys === 4) return { errors: [{ message: "Outbound labels balance too low", extensions: { code: "INSUFFICIENT_FUNDS" } }] };
      return { data: { purchaseCarrierShipment: { shipmentId: `sh_${buys}`, carrier: "USPS", service: "GroundAdvantage", rate: { amount: buys === 1 ? "7.50" : "12.00", currency: "USD" }, shipmentPackages: [{ trackingNumber: `9400${buys}`, labelUrl: `https://files.redo.example/l${buys}.pdf` }] } } };
    };
    const r = await buyRedo(env, from, to, [box(2), box(5)], "redo:n:ca_1:USPS:GroundAdvantage", { reference: "#1042" });
    expect(queries[0]).toContain('carrier: "USPS" service: "GroundAdvantage" carrierAccountId: "ca_1" idempotencyKey: "#1042-');
    expect(r).toMatchObject({ carrier: "USPS", shipmentId: "redo:sh_1,sh_2", trackingNumbers: ["94001", "94002"], cost: 19.5, perBox: [7.5, 12], format: "PDF" });
    expect(r.labels).toEqual([btoa("%PDF-1"), btoa("%PDF-1")]);
    // The second box of the next order runs out of funds: the box bought before it is voided
    queries = [];
    await expect(buyRedo(env, from, to, [box(2), box(5)], "redo:n:ca_1:USPS:GroundAdvantage", {})).rejects.toThrow(/outbound labels balance/);
    expect(queries.filter((q) => q.includes("voidCarrierShipment")).map((q) => /shipmentId: "(\w+)"/.exec(q)![1])).toEqual(["sh_3"]);
  });

  it("international: customs with HS codes and who pays duties; asks for HS codes when missing", async () => {
    answer = () => ({ data: { getShippingLabelQuotes: { rates: [rate("USPS", "PriorityMailInternational", "41.00")] } } });
    const intl = { ...to, country: "CA", state: "ON", zip: "M5H 2N2" };
    const customs: any = { contents: "merchandise", dutiesPaidBy: "recipient", nonDelivery: "return", signer: "Tim", items: [{ productKey: "y", description: "Acrylic yarn", hsCode: "5509.32", origin: "US", qty: 4, unitValue: 16, unitWeightLb: 0.6 }] };
    await getRedoRates(env, from, intl, [box(3)], undefined, customs);
    expect(queries[0]).toContain('customs: {contentsType: MERCHANDISE nonDeliveryOption: RETURN items: [{description: "Acrylic yarn" quantity: 4 unitValue: {amount: "16.00" currency: "USD"} unitWeight: {unit: POUND value: 0.6} originCountry: "US" hsTariffNumber: "550932"}]} deliveredDutyPaid: false');
    await expect(getRedoRates(env, from, intl, [box(3)], undefined, { ...customs, items: [{ ...customs.items[0], hsCode: "" }] })).rejects.toThrow(/HS code/);
    expect(await getRedoRates(env, from, intl, [box(3)])).toEqual([]); // no customs list yet: no Redo rates
  });

  it("drops an address field Redo doesn't take and asks again", async () => {
    let n = 0;
    answer = () => (n++ === 0
      ? { errors: [{ message: 'Field "phone" is not defined by type "ShippingAddressInput".' }] }
      : { data: { getShippingLabelQuotes: { rates: [rate("USPS", "GroundAdvantage", "8.15")] } } });
    expect(await getRedoRates(env, from, to, [box(3)])).toHaveLength(1);
    expect(queries[0]).toContain("phone:");
    expect(queries[1]).not.toContain("phone:");
  });

  it("sits beside the other carriers: rates merged, purchase and void routed by the code", async () => {
    answer = (q) => q.includes("voidCarrierShipment")
      ? { data: { voidCarrierShipment: { shipmentId: "sh_9", refundStatus: "REJECTED" } } }
      : q.includes("purchaseCarrierShipment")
        ? { data: { purchaseCarrierShipment: { shipmentId: "sh_9", carrier: "USPS", service: "GroundAdvantage", rate: { amount: "8.15", currency: "USD" }, shipmentPackages: [{ trackingNumber: "9400X", labelUrl: "https://files.redo.example/x.pdf" }] } } }
        : { data: { getShippingLabelQuotes: { rates: [rate("USPS", "GroundAdvantage", "8.15")] } } };
    expect((await getAllRates(env, from, to, [box(3)])).map((r) => r.serviceCode)).toEqual(["redo:1:ca_1:USPS:GroundAdvantage"]);
    const r = await purchase(env, from, to, [box(3)], "redo:1:ca_1:USPS:GroundAdvantage", { labelFormat: "ZPL" });
    expect(r).toMatchObject({ carrier: "USPS", shipmentId: "redo:sh_9", format: "PDF", cost: 8.15 });
    await expect(voidLabel(env, "redo:sh_9")).rejects.toThrow(/refused to cancel/);
    expect(sniffLabel(new TextEncoder().encode("^XA^FO50,50^XZ"))).toBe("ZPL");
  });

  it("reads what Redo's API accepts and points out signature options", async () => {
    const ref = (name: string, kind = "INPUT_OBJECT") => ({ kind: "NON_NULL", name: null, ofType: { kind, name, ofType: null } });
    answer = (q) => {
      if (q.includes("__schema")) return { data: { __schema: { queryType: { fields: [] }, mutationType: { fields: [
        { name: "getShippingLabelQuotes", description: "Quote", args: [{ name: "input", description: null, type: ref("ShipmentRequestInput") }] },
        { name: "createReturn", description: "not shipping", args: [] },
      ] } } } };
      const types: Record<string, any> = {
        ShipmentRequestInput: { name: "ShipmentRequestInput", kind: "INPUT_OBJECT", description: null, inputFields: [{ name: "options", description: "Extra services", type: { kind: "INPUT_OBJECT", name: "ShipmentOptionsInput", ofType: null } }], enumValues: null },
        ShipmentOptionsInput: { name: "ShipmentOptionsInput", kind: "INPUT_OBJECT", description: null, inputFields: [{ name: "signatureConfirmation", description: "Require a signature", type: { kind: "ENUM", name: "SignatureConfirmation", ofType: null } }], enumValues: null },
        SignatureConfirmation: { name: "SignatureConfirmation", kind: "ENUM", description: null, inputFields: null, enumValues: [{ name: "NONE" }, { name: "SIGNATURE" }, { name: "ADULT_SIGNATURE" }] },
      };
      const names = [...q.matchAll(/__type\(name: "(\w+)"\)/g)].map((m) => m[1]);
      return { data: Object.fromEntries(names.map((n, i) => [`t${i}`, types[n] ?? null])) };
    };
    const r = await redoSchema(env);
    expect(r.operations.map((o) => o.name)).toEqual(["getShippingLabelQuotes"]);
    expect(r.types.map((t) => t.name)).toEqual(["ShipmentRequestInput", "ShipmentOptionsInput", "SignatureConfirmation"]);
    expect(r.matches).toEqual([
      "ShipmentRequestInput.options (ShipmentOptionsInput)",
      "ShipmentOptionsInput.signatureConfirmation (SignatureConfirmation)",
      "SignatureConfirmation.(values): NONE, SIGNATURE, ADULT_SIGNATURE",
    ]);
  });

  it("checks Redo daily for signature support and remembers when it showed up", async () => {
    const db = { ...env, DB: testD1() };
    let hasSignature = false;
    let schemaCalls = 0;
    answer = (q) => {
      if (q.includes("__schema")) { schemaCalls++; return { data: { __schema: { queryType: { fields: [] }, mutationType: { fields: [{ name: "purchaseCarrierShipment", description: null, args: [{ name: "input", description: null, type: { kind: "INPUT_OBJECT", name: "PurchaseCarrierShipmentInput", ofType: null } }] }] } } } }; }
      return { data: { t0: { name: "PurchaseCarrierShipmentInput", kind: "INPUT_OBJECT", description: null, enumValues: null, inputFields: [
        { name: "service", description: null, type: { kind: "SCALAR", name: "String", ofType: null } },
        ...(hasSignature ? [{ name: "signatureConfirmation", description: null, type: { kind: "SCALAR", name: "String", ofType: null } }] : []),
      ] } } };
    };
    const t0 = Date.parse("2026-10-06T12:00:00Z");
    expect(await redoSignatureWatch(db, t0)).toMatchObject({ found: [], foundAt: null, error: null }); // "service" alone isn't a match
    hasSignature = true;
    expect((await redoSignatureWatch(db, t0 + 3600_000))!.found).toEqual([]); // already checked today
    expect(schemaCalls).toBe(1);
    expect(await redoSignatureWatch(db, t0 + 24 * 3600_000)).toMatchObject({ found: ["PurchaseCarrierShipmentInput.signatureConfirmation (String)"], foundAt: "2026-10-07T12:00:00.000Z" });
    expect(await redoSignatureWatch({ DB: db.DB } as any, t0 + 48 * 3600_000)).toBeNull(); // Redo not connected: nothing to check
  });
});

describe("one row per carrier service", async () => {
  const { dedupeRates } = await import("../src/lib/carriers");
  const { chooseRate } = await import("../src/lib/fulfillment");
  const r = (serviceCode: string, carrier: string, serviceName: string, total: number) => ({ serviceCode, carrier, serviceName, total, listTotal: total, currency: "USD", days: 3 });
  it("drops repeats from other connections and accounts, keeping the cheapest (direct on a tie)", () => {
    const rates = dedupeRates([
      r("03", "UPS", "UPS Ground", 11.21),
      r("redo:1:ca_a:UPS:Ground", "UPS", "UPS Ground · Redo", 11.21),
      r("redo:1:ca_b:UPS:Ground", "UPS", "UPS Ground · Redo", 11.21),
      r("12", "UPS", "UPS 3 Day Select", 16.44),
      r("redo:1:ca_a:UPS:3daySelect", "UPS", "UPS 3 Day Select · Redo", 15.9),
      r("usps:GroundAdvantage", "USPS", "USPS Ground Advantage", 8.4),
      r("redo:1:ca_u:USPS:GroundAdvantage", "USPS", "USPS Ground Advantage · Redo", 8.15),
    ]);
    expect(rates.map((x) => [x.serviceCode, x.alt ?? []])).toEqual([
      ["redo:1:ca_u:USPS:GroundAdvantage", ["usps:GroundAdvantage"]],
      ["03", ["redo:1:ca_a:UPS:Ground", "redo:1:ca_b:UPS:Ground"]],
      ["redo:1:ca_a:UPS:3daySelect", ["12"]],
    ]);
    // A rule asking for UPS 3 Day Select (12) still gets that service, now through Redo
    expect(chooseRate(rates, "12").serviceCode).toBe("redo:1:ca_a:UPS:3daySelect");
    expect(redoServiceName("UPS", "3daySelect")).toBe("UPS 3 Day Select · Redo");
  });
});
