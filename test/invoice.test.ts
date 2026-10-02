import { describe, expect, it } from "vitest";
import { invoiceTotals, renderCommercialInvoice } from "../src/lib/invoice";
import { cleanDraft } from "../src/lib/drafts";

const customs = {
  contents: "merchandise" as const, dutiesPaidBy: "recipient" as const, nonDelivery: "return" as const, signer: "Tim Eads",
  items: [
    { productKey: "gun", lineId: "l1", description: "Tufting gun", hsCode: "846729", origin: "CN", qty: 1, unitValue: 120, unitWeightLb: 3.2 },
    { productKey: "yarn", lineId: "l2", description: "Acrylic yarn <2ply>", hsCode: "", origin: "US", qty: 4, unitValue: 12.5, unitWeightLb: 0.5 },
  ],
};
const from = { name: "Tuft the World", company: "Tuft the World", phone: "2155550100", address1: "5400 Grays Ave", city: "Philadelphia", state: "PA", zip: "19143", country: "US" };
const to = { name: "Jean Tremblay", address1: "10 Rue Main", city: "Montréal", state: "QC", zip: "H2X 1Y4", country: "CA" };

describe("commercial invoice", () => {
  it("totals value, weight and units", () => {
    expect(invoiceTotals(customs)).toEqual({ value: 170, weight: 5.2, units: 5 });
  });

  it("prints one letter page per copy with the edited values, escaped", () => {
    const html = renderCommercialInvoice({ from, to, customs, orderName: "#68800-TG", date: "2026-10-02", invoiceNumber: "CI-68800-TG", tracking: ["1Z999"], carrier: "UPS", service: "UPS Standard", packages: 1, weightLb: 6, taxId: "12-3456789", copies: 3 });
    expect(html).toContain("@page { size: letter");
    expect(html.match(/<section class="ci">/g)).toHaveLength(3);
    expect(html).toContain("Copy 2 of 3");
    expect(html).toContain("$170.00 USD");
    expect(html).toContain("$50.00"); // 4 × 12.50
    expect(html).toContain("Acrylic yarn &lt;2ply&gt;");
    expect(html).toContain("DAP");
    expect(html).toContain("Tax ID / EIN: 12-3456789");
    expect(html).toContain("1Z999");
    expect(html).toContain("October 2, 2026");
  });

  it("keeps the edited customs list in the order's saved choices", () => {
    const d = cleanDraft({ boxes: [{ length: 10, width: 8, height: 4, weight: 2, items: {} }], customs });
    expect(d?.customs?.items[0].unitValue).toBe(120);
    expect(cleanDraft({ boxes: [{ length: 10, width: 8, height: 4, items: {} }] })?.customs).toBeNull();
  });
});
