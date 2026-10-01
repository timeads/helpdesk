import { describe, expect, it } from "vitest";
import { chooseRate, itemsKey, itemsWeightLb } from "../src/lib/fulfillment";
import { code128Svg } from "../src/lib/code128";

const rates = [
  { serviceCode: "01", serviceName: "UPS Next Day Air", total: 62.81, listTotal: 70, currency: "USD", days: 1 },
  { serviceCode: "03", serviceName: "UPS Ground", total: 9.62, listTotal: 12.34, currency: "USD", days: 2 },
  { serviceCode: "13", serviceName: "UPS Next Day Air Saver", total: 36.75, listTotal: 55.94, currency: "USD", days: 1 },
  { serviceCode: "93", serviceName: "UPS Ground Saver", total: 8.1, listTotal: 9, currency: "USD", days: null },
];

describe("chooseRate", () => {
  it("picks cheapest, fastest (cheapest among fastest) or a named service", () => {
    expect(chooseRate(rates, "cheapest").serviceCode).toBe("93");
    expect(chooseRate(rates, "fastest").serviceCode).toBe("13");
    expect(chooseRate(rates, "03").serviceCode).toBe("03");
    expect(chooseRate(rates, "59").serviceCode).toBe("93"); // unavailable → cheapest
  });
});

const order = (lines: any[]) => ({ lineItems: { nodes: lines } }) as any;

describe("package learning helpers", () => {
  it("keys identical item sets the same regardless of order", () => {
    const a = order([{ sku: "YARN-1", title: "Yarn", quantity: 2 }, { sku: "GUN", title: "Gun", quantity: 1 }]);
    const b = order([{ sku: "gun", title: "Gun", quantity: 1 }, { sku: "yarn-1", title: "Yarn", quantity: 2 }]);
    expect(itemsKey(a)).toBe(itemsKey(b));
    expect(itemsKey(a)).not.toBe(itemsKey(order([{ sku: "GUN", quantity: 2 }])));
  });
  it("sums product weights in pounds, or null when any is missing", () => {
    const w = (value: number, unit: string) => ({ inventoryItem: { measurement: { weight: { value, unit } } } });
    expect(itemsWeightLb(order([{ quantity: 2, variant: w(8, "OUNCES") }, { quantity: 1, variant: w(1, "POUNDS") }]))).toBe(2);
    expect(itemsWeightLb(order([{ quantity: 1, variant: w(1, "POUNDS") }, { quantity: 1, variant: null }]))).toBeNull();
  });
});

describe("code128", () => {
  it("renders a barcode SVG with quiet zones", () => {
    const svg = code128Svg("68762-TG");
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/<rect x=/g) ?? []).length).toBeGreaterThan(20);
  });
});
