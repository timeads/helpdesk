import { describe, expect, it } from "vitest";
import { evaluateRules, type ShippingRule } from "../src/lib/rules";
import { buildRateRequest, buildShipRequest } from "../src/lib/ups";

const order = (lines: { title: string; quantity: number; sku?: string }[], total: string, state = "PA") =>
  ({
    lineItems: { nodes: lines.map((l) => ({ ...l, sku: l.sku ?? null })) },
    totalPriceSet: { shopMoney: { amount: total, currencyCode: "USD" } },
    shippingAddress: { provinceCode: state, countryCodeV2: "US" },
    shippingLines: { nodes: [{ title: "Standard" }] },
  }) as any;

const REDO: ShippingRule[] = [
  {
    id: 1, name: "Tufting machine only > standard box", enabled: true,
    conditions: [
      { field: "item_quantity", op: "eq", value: "1" },
      { field: "product_names", op: "includes_any", value: "ak5 - cut & loop tufting machine" },
    ],
    actions: [{ type: "set_package", value: "Standard" }],
  },
  {
    id: 2, name: "Signature required over $250", enabled: true,
    conditions: [{ field: "order_total", op: "gt", value: "250" }],
    actions: [{ type: "require_signature", value: "standard" }],
  },
];

describe("shipping rules (Redo automations)", () => {
  it("puts a lone AK5 machine in the Standard box and asks for a signature over $250", () => {
    const r = evaluateRules(order([{ title: "AK5 - Cut & Loop Tufting Machine", quantity: 1 }], "329.00"), REDO);
    expect(r).toEqual({ packageName: "Standard", signature: "standard", signatureRule: "Signature required over $250", service: null, hold: null, matched: ["Tufting machine only > standard box", "Signature required over $250"] });
  });
  it("does not apply the box rule when other items ship with the machine", () => {
    const r = evaluateRules(order([{ title: "AK5 - Cut & Loop Tufting Machine", quantity: 1 }, { title: "Yarn", quantity: 2 }], "120"), REDO);
    expect(r.packageName).toBeNull();
    expect(r.signature).toBeNull();
  });
  it("skips disabled rules and treats $250 exactly as not over", () => {
    const r = evaluateRules(order([{ title: "Yarn", quantity: 1 }], "250.00"), REDO.map((x) => ({ ...x, enabled: x.id !== 1 })));
    expect(r.signature).toBeNull();
  });
});

describe("UPS signature option", () => {
  const from = { name: "Tuft HQ", address1: "5400 Grays Ave", city: "Philadelphia", state: "PA", zip: "19143", country: "US", phone: "2155550100" };
  const to = { name: "Jane", address1: "1 Main St", city: "Austin", state: "TX", zip: "78701", country: "US" };
  it("adds delivery confirmation to rated and shipped packages", () => {
    const rate = buildRateRequest("A1", from, to, [{ length: 16, width: 12, height: 6, weight: 7 }], "standard");
    expect(rate.RateRequest.Shipment.Package[0]).toMatchObject({ PackageServiceOptions: { DeliveryConfirmation: { DCISType: "2" } } });
    const ship = buildShipRequest("A1", from, to, [{ length: 10, width: 7, height: 0, weight: 0.4 }], "03", { labelFormat: "GIF", signature: "adult" });
    expect(ship.ShipmentRequest.Shipment.Package[0]).toMatchObject({
      Dimensions: { Height: "1" },
      PackageServiceOptions: { DeliveryConfirmation: { DCISType: "3" } },
    });
  });
});

describe("signature rules", () => {
  const sigRule = (value: string): ShippingRule => ({ id: 9, name: "Signature over", enabled: true, conditions: [{ field: "order_total", op: "gt", value }], actions: [{ type: "require_signature", value: "standard" }] });
  const yarnOrder = order([{ title: "Reflect Wool Yarn", quantity: 2 }, { title: "Charcoal SoFAT Tee (Fitted)", quantity: 1 }], "61.69", "OK");

  it("says which rule asked for the signature, and reads $ and commas in amounts", () => {
    expect(evaluateRules(order([{ title: "The Duo", quantity: 1 }], "329.00"), [sigRule("$250")])).toMatchObject({ signature: "standard", signatureRule: "Signature over" });
    expect(evaluateRules(order([{ title: "Frame", quantity: 1 }], "1200.00"), [sigRule("1,000")]).signature).toBe("standard");
    expect(evaluateRules(yarnOrder, [sigRule("250")])).toMatchObject({ signature: null, signatureRule: null });
    expect(evaluateRules(yarnOrder, [sigRule(" ")]).signature).toBeNull(); // a blank amount never matches
    expect(evaluateRules(yarnOrder, [sigRule("about 250")]).signature).toBeNull();
  });

  it("a saved “No signature” beats the rule; a saved signature says it was chosen", async () => {
    const { applyDraft, cleanDraft } = await import("../src/lib/drafts");
    const plan: any = { boxes: [{ items: {} }], signature: "standard", signatureFrom: "rule", service: null, rules: { signatureRule: "Signature over" } };
    const box = { length: 10, width: 8, height: 4, weight: 2, items: {} };
    const off = applyDraft(plan, cleanDraft({ boxes: [box], signature: "none" })!, [], []);
    expect([off.signature, off.signatureFrom]).toEqual([null, "saved-none"]);
    const on = applyDraft({ ...plan, signature: null, signatureFrom: null }, cleanDraft({ boxes: [box], signature: "adult" })!, [], []);
    expect([on.signature, on.signatureFrom]).toEqual(["adult", "saved"]);
    const untouched = applyDraft(plan, cleanDraft({ boxes: [box] })!, [], []);
    expect([untouched.signature, untouched.signatureFrom]).toEqual(["standard", "rule"]);
  });
});
