// Per-computer print settings + Zebra Browser Print (Zebra's free local print agent).
// Each packing computer keeps its own choice in this browser, like Redo's "workstations".
import { h, modal, toast } from "./ui.js";

const KEY = "helpdesk.printing";
const DEFAULTS = { labels: "browser", slips: "4x6" }; // labels: "browser" | "zebra"; slips: "4x6" | "letter"

export function printSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrintSettings(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...printSettings(), ...next }));
  } catch { /* private mode: settings last for this page only */ }
}

export const labelFormat = () => (printSettings().labels === "zebra" ? "ZPL" : "GIF");

// Browser Print listens on https://localhost:9101 (and http://localhost:9100).
const AGENTS = ["https://localhost:9101", "http://localhost:9100"];

async function agentFetch(path, init) {
  let lastError;
  for (const base of AGENTS) {
    try {
      const res = await fetch(base + path, init);
      if (res.ok) return res;
      lastError = new Error(`Zebra Browser Print answered ${res.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    "Can't reach Zebra Browser Print on this computer. Make sure it's installed and running" +
      (lastError?.message ? ` (${lastError.message})` : ""),
  );
}

export async function zebraPrinter() {
  const res = await agentFetch("/default?type=printer");
  const text = await res.text();
  if (!text.trim()) throw new Error("Zebra Browser Print is running but has no default printer — pick one in its settings");
  return JSON.parse(text);
}

export async function sendZpl(zpl) {
  const device = await zebraPrinter();
  // text/plain keeps this a "simple" request (no CORS preflight), as Zebra's own library does
  await agentFetch("/write", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ device, data: zpl }) });
  return device;
}

/** Opens a blank tab immediately (inside the click) so pop-up blockers allow it; navigate it later. */
export function reserveWindow() {
  if (printSettings().labels === "zebra") return null;
  const w = window.open("about:blank", "_blank");
  if (w) w.document.write("<p style='font:14px system-ui;padding:20px'>Preparing labels…</p>");
  return w;
}

/** Asks what to do about labels that were printed before: "again" | "new" | "cancel". */
function reprintChoice(title, lines, freshCount) {
  return new Promise((resolve) => {
    let answered = false;
    const pick = (v) => { answered = true; resolve(v); document.querySelector(".modal")?.remove(); };
    modal(title, h("div", { class: "stack" },
      h("ul", { style: { margin: 0, paddingLeft: "20px" } }, lines.map((l) => h("li", {}, l))),
      h("p", { class: "small muted", style: { margin: 0 } }, "Printing again makes a duplicate label for the same shipment."),
      h("div", { class: "row" },
        freshCount ? h("button", { class: "btn primary", onclick: () => pick("new") }, `Print only the ${freshCount} new one${freshCount === 1 ? "" : "s"}`) : null,
        h("button", { class: freshCount ? "btn" : "btn primary", onclick: () => pick("again") }, freshCount ? "Print all again" : "Print again"),
        h("button", { class: "btn ghost", onclick: () => pick("cancel") }, "Cancel"))),
    { width: 480, onClose: () => { if (!answered) resolve("cancel"); } });
  });
}

/** Prints labels by shipment ids or batch, to Zebra or the browser print dialog. */
export async function printLabels({ ids, batch }, win = null) {
  const q = batch ? `batch=${encodeURIComponent(batch)}` : `ids=${ids.join(",")}`;
  if (printSettings().labels === "zebra") {
    // Ask before sending labels that were printed before (the browser print page shows its own warning)
    const st = await fetch(`/api/shipping/labels/print-status?${q}`).then((r) => (r.ok ? r.json() : { labels: [] })).catch(() => ({ labels: [] }));
    const done = st.labels.filter((l) => l.printedAt);
    if (done.length) {
      const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const lines = done.slice(0, 8).map((l) => `${l.name || "Label"} — printed ${when(l.printedAt)}${l.count > 1 ? ` (${l.count} times)` : ""}`);
      const fresh = st.labels.filter((l) => !l.printedAt).map((l) => l.id);
      const choice = await reprintChoice(done.length === st.labels.length
        ? `${done.length === 1 ? "This label was" : `All ${done.length} labels were`} already printed`
        : `${done.length} of ${st.labels.length} labels were already printed`, lines, fresh.length);
      if (choice === "cancel") return;
      if (choice === "new") return printLabels({ ids: fresh });
    }
    const res = await fetch(`/api/shipping/labels/print?${q}&format=zpl`);
    if (!res.ok) throw new Error("Couldn't load the labels");
    const zpl = await res.text();
    if (!zpl.trim()) {
      // Labels bought as images (before switching to Zebra) still print through the browser
      window.open(`/api/shipping/labels/print?${q}`, "_blank");
      return;
    }
    const device = await sendZpl(zpl);
    const ids = st.labels.map((l) => l.id);
    if (ids.length) fetch("/api/shipping/labels/printed", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).catch(() => {});
    toast(`Sent to ${device.name || "Zebra printer"}`);
    return;
  }
  const url = `/api/shipping/labels/print?${q}`;
  if (win && !win.closed) win.location.href = url;
  else window.open(url, "_blank");
}

export function openPackingSlips(orderIds, win = null) {
  const url = `/api/shipping/packing-slips?size=${printSettings().slips}&ids=${orderIds.map(encodeURIComponent).join(",")}`;
  if (win && !win.closed) win.location.href = url;
  else if (!window.open(url, "_blank")) toast("Allow pop-ups for this site to print packing slips", true);
}

export async function testZebra() {
  const zpl = "^XA^CF0,40^FO40,60^FDTuft the World^FS^CF0,30^FO40,120^FDZebra test label OK^FS^FO40,180^BY3^BCN,100,Y,N,N^FDTEST-1234^FS^XZ";
  return sendZpl(zpl);
}
