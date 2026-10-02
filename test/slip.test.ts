import { describe, expect, it } from "vitest";
import { DEFAULT_SLIP, SLIP_SECTIONS, cleanSlip, renderSlip } from "../src/lib/slip";
import { demoOrders } from "../src/lib/demo";

const order = () => {
  const o = demoOrders()[0];
  return { ...o, requestedService: "UPS Ground", plan: { preset: { name: "Box" }, boxes: [{ preset: { name: "Box" } }] } };
};

describe("cleanSlip", () => {
  it("fills in defaults and keeps every section once", () => {
    const l = cleanSlip({ sections: [{ id: "items", on: true }, { id: "items", on: false }, { id: "bogus" }], fontSize: "huge" });
    expect(l.sections.map((s) => s.id).sort()).toEqual([...SLIP_SECTIONS].sort());
    expect(l.sections[0]).toEqual({ id: "items", on: true });
    expect(l.fontSize).toBe("m");
    expect(l.message).toBe(DEFAULT_SLIP.message);
  });
  it("only accepts small PNG/JPEG data URLs as the logo", () => {
    expect(cleanSlip({ logo: "data:image/png;base64,iVBORw0KGgo=" }).logo).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(cleanSlip({ logo: "javascript:alert(1)" }).logo).toBeNull();
    expect(cleanSlip({ logo: "data:image/svg+xml;base64,PHN2Zz4=" }).logo).toBeNull();
    expect(cleanSlip({ logo: "data:image/png;base64," + "A".repeat(500_000) }).logo).toBeNull();
  });
});

describe("renderSlip", () => {
  it("follows the section order and hides sections that are off", () => {
    const layout = cleanSlip({
      ...DEFAULT_SLIP,
      sections: [{ id: "message", on: true }, { id: "items", on: true }, { id: "barcode", on: false }, { id: "shipto", on: false }],
      message: "Hi <there>",
      footer: "tufttheworld.com",
    });
    const html = renderSlip(order() as any, "4x6", null, layout);
    expect(html.indexOf("Hi &lt;there&gt;")).toBeLessThan(html.indexOf("<table"));
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Ship to");
    expect(html).toContain("tufttheworld.com");
  });
  it("adds the logo, photos and prices when turned on", () => {
    const layout = cleanSlip({ ...DEFAULT_SLIP, logo: "data:image/png;base64,iVBORw0KGgo=", itemImages: true, showPrices: true, logoSize: "l" });
    const html = renderSlip(order() as any, "letter", null, layout);
    expect(html).toContain('class="logo l"');
    expect(html).toContain('<td class="img">');
    expect(html).toMatch(/<td class="p">\$\d/);
    expect(html).toContain("slip letter");
  });
});

describe("split orders", () => {
  it("prints one slip per box with only that box's items", () => {
    const o = order() as any;
    const [a, b] = o.lineItems.nodes;
    const layout = cleanSlip({ ...DEFAULT_SLIP });
    const html = renderSlip(o, "4x6", null, layout, { n: 2, of: 2, name: "Kit Box 8\"", tracking: "1ZTRACK2", qty: { [b.id]: 1 } });
    expect(html).toContain("Box 2 of 2");
    expect(html).toContain("1ZTRACK2");
    expect(html).toContain("Kit Box 8&quot;");
    expect(html).toContain(b.title);
    expect(html).not.toContain(`<b class="it">${a.title}</b>`);
    // The box's own barcode (scans as "<order>/B2") is labelled under it
    expect(html).toMatch(/class="v">\d+ · Box 2 of 2</);
  });
});
