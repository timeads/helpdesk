// Packing slip layout (Settings → Packing slip) and the HTML each slip is printed from.
// Slips are black and white for thermal 4×6 printers: the logo is converted to pure black/white
// in the browser before it's saved, and product photos print in grayscale.
import type { Address } from "./ups";
import type { ShopifyOrder } from "./shopify";
import { code128Svg } from "./code128";
import { escapeHtml } from "./mime";
import { getSetting } from "./util";
import type { Env } from "../env";

export const SLIP_SECTIONS = ["shipto", "shipping", "items", "note", "message", "barcode"] as const;
export type SlipSection = (typeof SLIP_SECTIONS)[number];

export interface SlipLayout {
  logo: string | null; // data:image/png;base64,… (already black & white)
  logoSize: "s" | "m" | "l";
  align: "left" | "center";
  storeName: string;
  showStoreName: boolean;
  showReturnAddress: boolean;
  sections: { id: SlipSection; on: boolean }[];
  itemImages: boolean;
  showSku: boolean;
  showItemBarcode: boolean;
  showPrices: boolean;
  fontSize: "s" | "m" | "l";
  message: string;
  footer: string;
}

export const DEFAULT_SLIP: SlipLayout = {
  logo: null,
  logoSize: "m",
  align: "left",
  storeName: "Tuft the World",
  showStoreName: true,
  showReturnAddress: true,
  sections: SLIP_SECTIONS.map((id) => ({ id, on: true })),
  itemImages: false,
  showSku: true,
  showItemBarcode: true,
  showPrices: false,
  fontSize: "m",
  message: "Thanks for tufting with us!",
  footer: "",
};

const MAX_LOGO = 400_000; // characters of data URL (~300 KB image)
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Validates a layout from the settings screen, filling gaps from the defaults. */
export function cleanSlip(input: any): SlipLayout {
  const i = input && typeof input === "object" ? input : {};
  const logo = typeof i.logo === "string" && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(i.logo) && i.logo.length <= MAX_LOGO ? i.logo : null;
  const seen = new Set<SlipSection>();
  const sections: SlipLayout["sections"] = [];
  for (const s of Array.isArray(i.sections) ? i.sections : []) {
    const id = s?.id as SlipSection;
    if (SLIP_SECTIONS.includes(id) && !seen.has(id)) {
      seen.add(id);
      sections.push({ id, on: s.on !== false });
    }
  }
  for (const id of SLIP_SECTIONS) if (!seen.has(id)) sections.push({ id, on: true }); // sections added in later versions
  const bool = (k: keyof SlipLayout) => (typeof i[k] === "boolean" ? i[k] : DEFAULT_SLIP[k]) as boolean;
  return {
    logo,
    logoSize: pick(i.logoSize, ["s", "m", "l"] as const, "m"),
    align: pick(i.align, ["left", "center"] as const, "left"),
    storeName: typeof i.storeName === "string" ? i.storeName.slice(0, 60) : DEFAULT_SLIP.storeName,
    showStoreName: bool("showStoreName"),
    showReturnAddress: bool("showReturnAddress"),
    sections,
    itemImages: bool("itemImages"),
    showSku: bool("showSku"),
    showItemBarcode: bool("showItemBarcode"),
    showPrices: bool("showPrices"),
    fontSize: pick(i.fontSize, ["s", "m", "l"] as const, "m"),
    message: typeof i.message === "string" ? i.message.slice(0, 300) : DEFAULT_SLIP.message,
    footer: typeof i.footer === "string" ? i.footer.slice(0, 120) : "",
  };
}

export const slipLayout = async (env: Env) => cleanSlip(await getSetting<unknown>(env, "slip_layout", DEFAULT_SLIP));

export type SlipOrder = Pick<ShopifyOrder, "name" | "createdAt" | "note" | "shippingAddress" | "lineItems"> & {
  requestedService?: string;
  plan?: { preset?: unknown; boxes: { preset?: { name: string } | null }[] };
};

const esc = (s: unknown) => escapeHtml(String(s ?? ""));
const br = (s: string) => esc(s).replace(/\n/g, "<br>");

export function renderSlip(o: SlipOrder, size: "4x6" | "letter", from: Address | null, layout: SlipLayout): string {
  const L = layout;
  const a = (o.shippingAddress ?? {}) as Record<string, string | null>;
  const code = o.name.replace(/^#/, "");
  const date = new Date(o.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const brand = [
    L.logo ? `<img class="logo ${L.logoSize}" src="${L.logo}" alt="">` : "",
    L.showStoreName && L.storeName ? `<div class="brand">${esc(L.storeName)}</div>` : "",
    L.showReturnAddress && from?.address1 ? `<div class="v">${esc([from.address1, `${from.city}, ${from.state} ${from.zip}`].join(" · "))}</div>` : "",
  ].join("");
  const orderBox = `<div class="right"><div class="order">${esc(o.name)}</div><div class="v">${esc(date)}</div></div>`;
  const header = `<header class="${L.align}"><div class="brandbox">${brand}</div>${orderBox}</header>`;

  const boxes = o.plan?.boxes ?? [];
  const parts: Record<SlipSection, () => string> = {
    shipto: () => `<div class="sec"><div class="lbl">Ship to</div><div>${br([a.name, a.company, a.address1, a.address2, `${a.city ?? ""}, ${a.provinceCode ?? ""} ${a.zip ?? ""}`, a.countryCodeV2 && a.countryCodeV2 !== "US" ? a.country : ""].filter(Boolean).join("\n"))}</div></div>`,
    shipping: () => `<div class="sec"><div class="lbl">Shipping</div><div>${esc(o.requestedService || "—")}</div>${o.plan?.preset && boxes.length ? `<div class="lbl" style="margin-top:4px">${boxes.length > 1 ? `Boxes (${boxes.length})` : "Box"}</div><div>${esc(boxes.map((b) => b.preset?.name ?? "Custom").join(" + "))}</div>` : ""}</div>`,
    items: () => {
      const rows = o.lineItems.nodes.map((l) => {
        const sub = [l.variantTitle ? esc(l.variantTitle) : "", L.showSku && l.sku ? `SKU ${esc(l.sku)}` : "", L.showItemBarcode && l.variant?.barcode ? `Barcode ${esc(l.variant.barcode)}` : ""].filter(Boolean).join(" · ");
        const price = l.discountedUnitPriceAfterAllDiscountsSet ? Number(l.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount) * l.quantity : null;
        return `<tr><td class="q">${l.quantity}</td>${L.itemImages ? `<td class="img">${l.image?.url ? `<img src="${esc(l.image.url)}" alt="">` : ""}</td>` : ""}<td><b>${esc(l.title)}</b>${sub ? `<div class="v">${sub}</div>` : ""}</td>${L.showPrices ? `<td class="p">${price !== null ? `$${price.toFixed(2)}` : ""}</td>` : ""}</tr>`;
      }).join("");
      return `<table><thead><tr><th class="q">Qty</th>${L.itemImages ? "<th></th>" : ""}<th>Item</th>${L.showPrices ? '<th class="p">Price</th>' : ""}</tr></thead><tbody>${rows}</tbody></table>`;
    },
    note: () => (o.note ? `<div class="note"><b>Note:</b> ${esc(o.note)}</div>` : ""),
    message: () => (L.message.trim() ? `<div class="msg">${br(L.message.trim())}</div>` : ""),
    barcode: () => `<div class="code">${code128Svg(code, { height: 48, module: 2 })}<div class="v">${esc(code)}</div></div>`,
  };
  const on = L.sections.filter((s) => s.on).map((s) => s.id);
  // Ship to + Shipping side by side when they're next to each other
  const html: string[] = [];
  for (let i = 0; i < on.length; i++) {
    const id = on[i];
    const next = on[i + 1];
    if ((id === "shipto" && next === "shipping") || (id === "shipping" && next === "shipto")) {
      html.push(`<div class="cols">${parts[id]()}${parts[next]()}</div>`);
      i++;
    } else html.push(parts[id]());
    if (id === "items") html.push('<div class="push"></div>'); // anything after the items sits at the bottom
  }
  return `<section class="slip ${size === "letter" ? "letter" : "s4x6"} f${L.fontSize}">${header}${html.join("")}${L.footer.trim() ? `<footer>${esc(L.footer.trim())}</footer>` : ""}</section>`;
}

export const SLIP_CSS = `
@page { margin: 0; }
html, body, .slip-root { margin: 0; background: #fff; color: #000; font: 11px/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.slip { box-sizing: border-box; break-after: page; padding: 0.2in; display: flex; flex-direction: column; gap: 8px; }
.slip.s4x6 { width: 4in; min-height: 6in; padding: 0.3in 0.32in; } /* thermal printers drift a little: keep text well clear of the edges */
.slip.letter { width: 8.5in; min-height: 11in; padding: 0.5in; gap: 14px; }
.slip.fs { font-size: 9.5px; } .slip.fm { font-size: 11px; } .slip.fl { font-size: 12.5px; }
.slip.letter.fs { font-size: 11.5px; } .slip.letter.fm { font-size: 13px; } .slip.letter.fl { font-size: 15px; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; border-bottom: 2px solid #000; padding-bottom: 6px; }
header.center { flex-direction: column; align-items: center; text-align: center; }
header.center .right { text-align: center; display: flex; gap: 8px; align-items: baseline; }
.brandbox { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
header.center .brandbox { align-items: center; }
.logo { display: block; max-width: 100%; object-fit: contain; object-position: left center; image-rendering: pixelated; }
header.center .logo { object-position: center; }
.logo.s { max-height: 0.35in; } .logo.m { max-height: 0.6in; } .logo.l { max-height: 0.9in; }
.letter .logo.s { max-height: 0.5in; } .letter .logo.m { max-height: 0.8in; } .letter .logo.l { max-height: 1.2in; }
.brand { font: 400 1.35em Georgia, serif; text-transform: uppercase; letter-spacing: .04em; }
.order { font-size: 1.45em; font-weight: 800; text-align: right; white-space: nowrap; }
.right { text-align: right; }
.v { color: #333; font-size: .86em; }
.lbl { font-size: .78em; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #333; }
.cols { display: grid; grid-template-columns: 1.3fr 1fr; gap: 10px; }
table { width: 100%; border-collapse: collapse; }
tr { break-inside: avoid; }
th { text-align: left; font-size: .78em; text-transform: uppercase; letter-spacing: .08em; color: #333; border-bottom: 1px solid #000; padding: 3px 0; }
td { border-bottom: 1px solid #bbb; padding: 4px 4px 4px 0; vertical-align: top; }
td.q, th.q { width: 2.4em; } td.q { font-weight: 800; font-size: 1.1em; }
td.img { width: 0.5in; } td.img img { width: 0.45in; height: 0.45in; object-fit: cover; filter: grayscale(1) contrast(1.2); display: block; }
td.p, th.p { text-align: right; white-space: nowrap; padding-right: 0; }
.note { border: 1px dashed #000; padding: 5px; }
.push { flex: 1; }
.msg { font-weight: 700; text-align: center; font-size: 1.1em; }
.code { text-align: center; }
.code svg { max-width: 100%; height: 40px; }
footer { text-align: center; font-size: .86em; border-top: 1px solid #000; padding-top: 4px; }
`;
