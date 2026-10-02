// Commercial invoice for international shipments: a letter-size page (one per copy) built from the
// customs list on the order page, for a normal printer. Carriers want 3 signed copies in a pouch
// on the box unless the account has paperless invoices.
import type { Address } from "./ups";
import type { Customs } from "./customs";
import { escapeHtml as esc } from "./mime";

export interface InvoiceInput {
  from: Address;
  to: Address;
  customs: Customs;
  orderName: string | null;
  date: string; // YYYY-MM-DD
  invoiceNumber: string;
  tracking: string[];
  carrier: string | null;
  service: string | null;
  packages: number;
  weightLb: number | null;
  taxId?: string;
  copies?: number;
}

const REASON: Record<Customs["contents"], string> = {
  merchandise: "Sale",
  gift: "Gift",
  sample: "Sample",
  returned_goods: "Return / repair",
  documents: "Documents",
  other: "Other",
};
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lb = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)} lb (${(n * 0.45359237).toFixed(2)} kg)`;
/** "CA" → "Canada (CA)" so customs officers don't have to decode it. */
function country(code: string | undefined) {
  const c = (code || "").toUpperCase();
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(c);
    return name && name !== c ? `${name} (${c})` : c;
  } catch {
    return c;
  }
}
const dateText = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

function addressBlock(a: Address, extra: string[] = []) {
  const lines = [
    a.company,
    a.name,
    a.address1,
    a.address2,
    [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    country(a.country),
    a.phone ? `Phone: ${a.phone}` : "",
    a.email ? a.email : "",
    ...extra,
  ].filter((x) => x && String(x).trim());
  return lines.map((l) => `<div>${esc(String(l))}</div>`).join("");
}

export function invoiceTotals(c: Customs) {
  const value = Math.round(c.items.reduce((n, i) => n + i.qty * i.unitValue, 0) * 100) / 100;
  const weight = c.items.reduce((n, i) => n + i.qty * i.unitWeightLb, 0);
  const units = c.items.reduce((n, i) => n + i.qty, 0);
  return { value, weight, units };
}

function page(x: InvoiceInput, copy: number, copies: number) {
  const c = x.customs;
  const t = invoiceTotals(c);
  const weight = x.weightLb && x.weightLb > 0 ? x.weightLb : t.weight;
  const incoterm = c.dutiesPaidBy === "sender" ? "DDP — Delivered Duty Paid (shipper pays duties & taxes)" : "DAP — Delivered At Place (recipient pays duties & taxes)";
  const rows = c.items.filter((i) => i.qty > 0).map((i, n) => `
    <tr>
      <td class="c">${n + 1}</td>
      <td>${esc(i.description)}</td>
      <td class="c mono">${esc(i.hsCode || "—")}</td>
      <td class="c">${esc(i.origin || "US")}</td>
      <td class="r">${i.qty}</td>
      <td class="r">${i.unitWeightLb > 0 ? (i.qty * i.unitWeightLb).toFixed(2) : "—"}</td>
      <td class="r">${usd(i.unitValue)}</td>
      <td class="r">${usd(i.qty * i.unitValue)}</td>
    </tr>`).join("");
  return `
  <section class="ci">
    <header>
      <div><h1>Commercial Invoice</h1>${copies > 1 ? `<div class="copy">Copy ${copy} of ${copies}</div>` : ""}</div>
      <table class="meta">
        <tr><th>Invoice no.</th><td>${esc(x.invoiceNumber)}</td></tr>
        <tr><th>Date</th><td>${esc(dateText(x.date))}</td></tr>
        ${x.orderName ? `<tr><th>Order</th><td>${esc(x.orderName)}</td></tr>` : ""}
        ${x.tracking.length ? `<tr><th>Tracking / AWB</th><td class="mono">${x.tracking.map(esc).join("<br>")}</td></tr>` : ""}
        ${x.carrier || x.service ? `<tr><th>Carrier</th><td>${esc([x.service || x.carrier].filter(Boolean).join(""))}</td></tr>` : ""}
      </table>
    </header>
    <div class="parties">
      <div class="box"><h2>Shipper / Exporter</h2>${addressBlock(x.from, x.taxId ? [`Tax ID / EIN: ${x.taxId}`] : [])}</div>
      <div class="box"><h2>Consignee (Ship to)</h2>${addressBlock(x.to)}</div>
    </div>
    <div class="terms">
      <div><span>Reason for export</span>${esc(REASON[c.contents] ?? "Sale")}</div>
      <div><span>Terms of sale (Incoterms)</span>${esc(incoterm)}</div>
      <div><span>Currency</span>USD — US Dollar</div>
      <div><span>Country of export</span>${esc(country(x.from.country || "US"))}</div>
      <div><span>Destination country</span>${esc(country(x.to.country))}</div>
      <div><span>Packages</span>${x.packages} · ${weight > 0 ? lb(weight) : "weight not set"}</div>
    </div>
    <table class="items">
      <thead><tr><th class="c">#</th><th>Description of goods</th><th class="c">HS code</th><th class="c">Origin</th><th class="r">Qty</th><th class="r">Weight (lb)</th><th class="r">Unit value</th><th class="r">Total value</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="r">${t.units}</td><td class="r">${t.weight > 0 ? t.weight.toFixed(2) : "—"}</td><td></td><td class="r">${usd(t.value)}</td></tr></tfoot>
    </table>
    <div class="sum">
      <div><span>Total declared value</span><b>${usd(t.value)} USD</b></div>
      <div><span>If undeliverable</span>${c.nonDelivery === "abandon" ? "Abandon" : "Return to shipper"}</div>
    </div>
    <p class="decl">I declare that all the information contained in this invoice is true and correct, and that the goods are of the origin shown. These commodities, technology, or software were exported from the United States in accordance with the Export Administration Regulations. Diversion contrary to U.S. law is prohibited.</p>
    <div class="sign">
      <div><div class="line"></div>Signature</div>
      <div><div class="line name">${esc(c.signer || "")}</div>Name</div>
      <div><div class="line name">${esc(dateText(x.date))}</div>Date</div>
    </div>
  </section>`;
}

const CSS = `
@page { size: letter; margin: 0.5in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.5pt/1.35 "Helvetica Neue", Arial, sans-serif; color: #000; background: #fff; }
.ci { page-break-after: always; break-after: page; }
.ci:last-child { page-break-after: auto; break-after: auto; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #000; padding-bottom: 10px; }
h1 { font-size: 20pt; margin: 0; letter-spacing: .02em; text-transform: uppercase; }
.copy { font-size: 9pt; margin-top: 4px; }
.meta { border-collapse: collapse; font-size: 9.5pt; }
.meta th { text-align: left; font-weight: 600; padding: 1px 10px 1px 0; white-space: nowrap; color: #333; }
.meta td { padding: 1px 0; }
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
.box { border: 1px solid #000; padding: 8px 10px; min-height: 1.4in; }
h2 { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 4px; }
.terms { display: grid; grid-template-columns: 1fr 1fr 1fr; border: 1px solid #000; border-width: 1px 0 0 1px; margin-top: 14px; }
.terms > div { border: 1px solid #000; border-width: 0 1px 1px 0; padding: 5px 8px; font-size: 9.5pt; }
.terms span, .sum span { display: block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .05em; color: #333; }
table.items { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 9.5pt; }
.items th { background: #eee; border: 1px solid #000; padding: 5px 6px; font-size: 8pt; text-transform: uppercase; text-align: left; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.items td { border: 1px solid #000; padding: 5px 6px; vertical-align: top; }
.items tfoot td { font-weight: 700; }
.items tr { page-break-inside: avoid; }
.c { text-align: center !important; } .r { text-align: right !important; white-space: nowrap; }
.mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 9pt; }
.sum { display: flex; justify-content: flex-end; gap: 28px; margin-top: 10px; text-align: right; }
.sum b { font-size: 13pt; }
.decl { font-size: 8.5pt; margin: 16px 0 0; }
.sign { display: grid; grid-template-columns: 2fr 1.4fr 1fr; gap: 18px; margin-top: 30px; font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; }
.line { border-bottom: 1px solid #000; height: 26px; margin-bottom: 3px; font-size: 10.5pt; text-transform: none; letter-spacing: 0; display: flex; align-items: flex-end; padding-bottom: 2px; }
.bar { position: sticky; top: 0; display: flex; gap: 10px; align-items: center; justify-content: center; padding: 10px; background: #f3efe6; border-bottom: 1px solid #ddd; font: 14px system-ui, sans-serif; }
.bar button { font: 600 14px system-ui, sans-serif; padding: 8px 16px; border-radius: 8px; border: 0; background: #1f3b33; color: #fff; cursor: pointer; }
.sheet { max-width: 7.5in; margin: 0 auto; padding: 0.4in 0; }
@media screen { .ci + .ci { margin-top: 0.5in; padding-top: 0.5in; border-top: 2px dashed #bbb; } }
@media print { .bar { display: none; } .sheet { padding: 0; max-width: none; } }
`;

/** A complete HTML page, one invoice per copy, that opens the print dialog by itself. */
export function renderCommercialInvoice(x: InvoiceInput): string {
  const copies = Math.min(5, Math.max(1, Math.round(x.copies ?? 3)));
  const pages = Array.from({ length: copies }, (_, i) => page(x, i + 1, copies)).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Commercial invoice ${esc(x.orderName ?? x.invoiceNumber)}</title>
<style>${CSS}</style></head><body>
<div class="bar">Letter size · ${copies} cop${copies === 1 ? "y" : "ies"} — sign each one and put them in a clear pouch on the box <button onclick="print()">Print</button></div>
<div class="sheet">${pages}</div>
<script>addEventListener("load", () => setTimeout(() => print(), 300));</script>
</body></html>`;
}
