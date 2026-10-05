// Per-computer print settings + Zebra Browser Print (Zebra's free local print agent).
// Each packing computer keeps its own choice in this browser, like Redo's "workstations".
import { actionToast, h, modal, toast } from "./ui.js";

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
let goodAgent = null; // the address that answered last time, tried first

const why = (e) =>
  e instanceof TypeError
    ? "the browser couldn't connect — Browser Print isn't running, or Chrome is blocking this site from talking to apps on this computer"
    : e?.message || String(e);

async function agentFetch(path, init) {
  const order = goodAgent ? [goodAgent, ...AGENTS.filter((a) => a !== goodAgent)] : AGENTS;
  const errors = [];
  for (const base of order) {
    try {
      const res = await fetch(base + path, init);
      if (res.ok) { goodAgent = base; return res; }
      errors.push(`${base.replace(/^https?:\/\//, "")}: answered ${res.status}`);
    } catch (e) {
      errors.push(`${base.replace(/^https?:\/\//, "")}: ${why(e)}`);
    }
  }
  const err = new Error(errors.join("; "));
  err.agentDown = true;
  throw err;
}

const usable = (d) => d && typeof d === "object" && d.uid && d.name;

/** Printers Browser Print can see (USB first). */
async function availablePrinters() {
  try {
    const r = await agentFetch("/available");
    const list = ((await r.json())?.printer ?? []).filter(usable);
    return list.sort((x, y) => (y.connection === "usb") - (x.connection === "usb"));
  } catch {
    return [];
  }
}

/**
 * The printer to send to: Browser Print's default when it's complete; otherwise (it can come back
 * with no name after a restart, and then every send fails with 500) the one it can actually see.
 */
export async function zebraPrinter({ skipDefault = false } = {}) {
  let res;
  try {
    res = await agentFetch("/default?type=printer");
  } catch (e) {
    throw new Error(`Can't reach Zebra Browser Print on this computer. Check that it's running (its icon is in the system tray / menu bar). Details: ${e.message}`);
  }
  const text = await res.text();
  let def = null;
  try { def = text.trim() ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (usable(def) && !skipDefault) return def;
  const list = await availablePrinters();
  const saved = printSettings().zebraName;
  const pick = list.find((d) => d.name === saved) ?? list[0];
  if (pick) return pick;
  if (usable(def)) return def;
  throw new Error("Zebra Browser Print is running but can't see a printer — check the USB cable and that the Zebra is on, then pick it in Browser Print's settings");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chunkSize = 4000; // shrinks for this session if Browser Print rejects pieces
// text/plain keeps this a "simple" request (no CORS preflight), as Zebra's own library does
const write = (device, data) => agentFetch("/write", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ device, data }) });
const read = async (device) => (await agentFetch("/read", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ device }) })).text();

/** Asks the Zebra how it is (~HQES): paused, head open, out of labels, errors. */
export async function zebraStatus(device) {
  await read(device).catch(() => ""); // drop anything old waiting to be read
  await write(device, "~HQES");
  let text = "";
  for (let i = 0; i < 6 && !/WARNINGS/.test(text); i++) { await sleep(250); text += await read(device).catch(() => ""); }
  const m = /ERRORS:\s+(\d)\s+(\w+)\s+(\w+)[\s\S]*?WARNINGS:\s+(\d)\s+(\w+)\s+(\w+)/.exec(text);
  if (!m) return { known: false, text: text.trim() || "no answer" };
  const err = parseInt(m[3], 16);
  const ERR = [[0x1, "out of labels (media out)"], [0x2, "out of ribbon"], [0x4, "print head open"], [0x8, "cutter jam"], [0x10, "print head too hot"], [0x20, "motor too hot"], [0x40, "bad print head element"], [0x80, "print head detected"], [0x100, "paused"]];
  const problems = m[1] === "1" ? ERR.filter(([bit]) => err & bit).map(([, t]) => t) : [];
  return { known: true, ok: !problems.length, problems, text: text.trim() };
}

/** Clears stuck or half-sent jobs and takes the printer out of pause. */
export async function resetZebra() {
  const device = await zebraPrinter();
  await write(device, "~JA"); // cancel everything waiting in the printer
  await sleep(300);
  await write(device, "^XA^XZ~PS"); // close any open format and resume
  return device;
}

/** Sends ZPL to the default Zebra one label at a time (big jobs in one request can fail), retrying a label once. */
export async function sendZpl(zpl) {
  let device = await zebraPrinter();
  // If the printer Browser Print calls default won't take anything, use the one it can see
  try {
    await write(device, "");
  } catch {
    const other = await zebraPrinter({ skipDefault: true }).catch(() => null);
    if (other && other.uid !== device.uid) device = other;
  }
  const jobs = zpl.match(/\^XA[\s\S]*?\^XZ/g) ?? [zpl];
  for (const [i, job] of jobs.entries()) {
    // Browser Print can reject large requests (500), so each label goes in pieces the printer joins;
    // a rejected piece is retried in smaller pieces (down to 512 bytes) before giving up
    let size = chunkSize;
    for (let pos = 0; pos < job.length;) {
      const piece = job.slice(pos, pos + size);
      try {
        await write(device, piece);
        pos += piece.length;
      } catch (e) {
        if (size > 512) { size = Math.max(512, Math.floor(size / 4)); chunkSize = size; await sleep(300); continue; }
        try { await write(device, piece); pos += piece.length; continue; } catch { /* give up below */ }
        if (pos > 0) await write(device, "^XZ").catch(() => {}); // close the half-sent label
        throw new Error(`Found ${device.name || "the Zebra"} but couldn't send ${jobs.length > 1 ? `label ${i + 1} of ${jobs.length}` : "the label"} (${Math.round(job.length / 1024)} KB, stopped at ${Math.round(pos / 1024)} KB)${i ? ` — the first ${i} printed` : ""}. Details: ${e.message}. Try Settings → Printing & slips → Reset printer.`);
      }
    }
    if (jobs.length > 1) await sleep(150); // let the printer take each one
  }
  return device;
}

/** Settings → "Check connection": each step on its own, so a failure says where it is. */
export async function zebraDiagnostics() {
  const out = [];
  for (const base of AGENTS) {
    try {
      const r = await fetch(`${base}/default?type=printer`);
      out.push({ ok: r.ok, text: `${base.replace(/^https?:\/\//, "")} ${r.ok ? "answers" : `answered ${r.status}`}` });
    } catch (e) {
      out.push({ ok: false, text: `${base.replace(/^https?:\/\//, "")}: ${why(e)}` });
    }
  }
  let device;
  try {
    const raw = await (await agentFetch("/default?type=printer")).json().catch(() => null);
    out.push(usable(raw)
      ? { ok: true, text: `Default printer: ${raw.name} · ${raw.connection}` }
      : { ok: true, text: "Default printer: incomplete in Browser Print — using the printer it can see instead" });
    device = await zebraPrinter();
    try { await write(device, ""); } catch { device = await zebraPrinter({ skipDefault: true }); }
    out.push({ ok: true, text: `Sending to: ${device.name} · ${device.connection}` });
    try {
      const r = await agentFetch("/available");
      const list = (await r.json())?.printer ?? [];
      out.push({ ok: list.length > 0, text: list.length ? `Printers Browser Print can see: ${list.map((d) => `${d.name} (${d.connection})`).join(", ")}` : "Browser Print can't see any printer — check the USB cable and that the printer is on" });
    } catch { /* older Browser Print versions don't list */ }
  } catch (e) {
    out.push({ ok: false, text: e.message });
    return out;
  }
  try {
    const st = await zebraStatus(device);
    out.push(st.known ? { ok: st.ok, text: st.ok ? "Printer status: ready" : `Printer status: ${st.problems.join(", ")}` } : { ok: true, text: `Printer status: couldn't read (${st.text.slice(0, 60)})` });
  } catch (e) {
    out.push({ ok: false, text: `Printer status: couldn't ask (${e.message})` });
  }
  // how big a single request Browser Print takes (comments only: nothing prints)
  const sizes = [100, 1000, 4000, 16000];
  const passed = [];
  for (const n of sizes) {
    const job = `^XA^FX${"x".repeat(Math.max(0, n - 12))}^FS^XZ`;
    try { await write(device, job); passed.push(n); } catch (e) { out.push({ ok: false, text: `A ${n >= 1000 ? `${n / 1000} KB` : `${n} byte`} request was refused (${e.message})` }); break; }
  }
  if (passed.length === sizes.length) out.push({ ok: true, text: "Requests up to 16 KB go through" });
  else if (passed.length) out.push({ ok: true, text: `Requests up to ${passed.at(-1) >= 1000 ? `${passed.at(-1) / 1000} KB` : `${passed.at(-1)} bytes`} go through — slips will be sent in pieces that size` }), (chunkSize = Math.max(512, passed.at(-1) - 200));
  return out;
}

/** Opens a blank tab immediately (inside the click) so pop-up blockers allow it; navigate it later. */
export function reserveWindow() {
  if (printSettings().labels === "zebra") return null;
  const w = window.open("about:blank", "_blank");
  if (w) w.document.write("<p style='font:14px system-ui;padding:20px'>Preparing labels…</p>");
  return w;
}

/** Asks what to do about labels that were printed before: "again" | "new" | "cancel". */
function reprintChoice(title, lines, freshCount, what = "label") {
  return new Promise((resolve) => {
    let answered = false;
    const pick = (v) => { answered = true; resolve(v); document.querySelector(".modal")?.remove(); };
    modal(title, h("div", { class: "stack" },
      h("ul", { style: { margin: 0, paddingLeft: "20px" } }, lines.map((l) => h("li", {}, l))),
      h("p", { class: "small muted", style: { margin: 0 } }, what === "label" ? "Printing again makes a duplicate label for the same shipment." : "Printing again makes a duplicate slip."),
      h("div", { class: "row" },
        freshCount ? h("button", { class: "btn primary", onclick: () => pick("new") }, `Print only the ${freshCount} new one${freshCount === 1 ? "" : "s"}`) : null,
        h("button", { class: freshCount ? "btn" : "btn primary", onclick: () => pick("again") }, freshCount ? "Print all again" : "Print again"),
        h("button", { class: "btn ghost", onclick: () => pick("cancel") }, "Cancel"))),
    { width: 480, onClose: () => { if (!answered) resolve("cancel"); } });
  });
}

/** Prints labels by shipment ids or batch, to Zebra or the browser print dialog. */
export async function printLabels({ ids, batch, box = null }, win = null) {
  // box: just that box's label of a multi-box shipment (packing one box at a time)
  const q = (batch ? `batch=${encodeURIComponent(batch)}` : `ids=${ids.join(",")}`) + (box ? `&box=${box}` : "");
  if (printSettings().labels === "zebra") {
    const res = await fetch(`/api/shipping/labels/print-data?${q}`, { credentials: "same-origin" });
    const st = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(st.error || "Couldn't load the labels");
    if (!st.labels.length) throw new Error("These were imported from Redo — reprint them in Redo or UPS");
    let labels = st.labels;
    // Ask before sending labels that were printed before
    const done = labels.filter((l) => l.printedAt);
    if (done.length) {
      const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const lines = done.slice(0, 8).map((l) => `${l.name || "Label"} — printed ${when(l.printedAt)}${l.count > 1 ? ` (${l.count} times)` : ""}`);
      const freshCount = labels.length - done.length;
      const choice = await reprintChoice(done.length === labels.length
        ? `${done.length === 1 ? "This label was" : `All ${done.length} labels were`} already printed`
        : `${done.length} of ${labels.length} labels were already printed`, lines, freshCount);
      if (choice === "cancel") return;
      if (choice === "new") labels = labels.filter((l) => !l.printedAt);
      if (!labels.length) return;
    }
    // ZPL labels go as they are; labels bought as images (UPS GIF / USPS PNG) are converted for the Zebra
    const dpi = Number(printSettings().zebraDpi) || 203;
    const jobs = [];
    for (const l of labels) {
      if (l.format === "ZPL") jobs.push(...l.data);
      else {
        const { imageToZpl } = await import("./zpl.js");
        for (const d of l.data) {
          if (l.format === "PDF") {
            const { pdfToPngs } = await import("./pdf-labels.js");
            for (const p of await pdfToPngs(d, dpi)) jobs.push(await imageToZpl(p.png, "PNG", dpi));
          } else jobs.push(await imageToZpl(d, l.format, dpi));
        }
      }
    }
    let device;
    try {
      device = await sendZpl(jobs.join("\n"));
    } catch (e) {
      actionToast(`Zebra didn't take it: ${e.message}`, "Print with dialog instead", () => window.open(`/api/shipping/labels/print?ids=${labels.map((l) => l.id).join(",")}`, "_blank"), 20000);
      return;
    }
    fetch("/api/shipping/labels/printed", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: labels.map((l) => l.id), box }) }).catch(() => {});
    toast(`${labels.length === 1 ? "Label" : `${labels.length} labels`} sent to ${device.name || "Zebra printer"}`);
    return;
  }
  const url = `/api/shipping/labels/print?${q}`;
  if (win && !win.closed) win.location.href = url;
  else window.open(url, "_blank");
}

/** Zebra + 4×6 slips: send them straight to the printer (unless turned off on this computer). */
export const slipsDirect = () => printSettings().labels === "zebra" && printSettings().slips === "4x6" && printSettings().slipsDirect !== false;

/** Packing slips for orders, or ({ shipment }) for one shipment — e.g. what's in a partial shipment. */
export function openPackingSlips(orderIds, win = null, { shipment = null } = {}) {
  if (slipsDirect()) {
    if (win && !win.closed) win.close();
    return printSlipsToZebra(orderIds, { shipment });
  }
  const url = `/api/shipping/packing-slips?size=${printSettings().slips}${shipment ? `&shipment=${shipment}` : `&ids=${orderIds.map(encodeURIComponent).join(",")}`}`;
  if (win && !win.closed) win.location.href = url;
  else if (!window.open(url, "_blank")) toast("Allow pop-ups for this site to print packing slips", true);
}

/** Draws each slip, converts it to ZPL and sends it to the Zebra — no window, no dialog. */
export async function printSlipsToZebra(orderIds, { sample = false, shipment = null } = {}) {
  try {
    const res = await fetch(`/api/shipping/packing-slips/data?${shipment ? `shipment=${shipment}` : `ids=${orderIds.map(encodeURIComponent).join(",")}`}`, { credentials: "same-origin" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't load the packing slips");
    let slips = data.slips;
    if (data.printed.length && !sample && !shipment) {
      const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const lines = data.printed.slice(0, 8).map((p) => `${p.name} — printed ${when(p.at)}${p.count > 1 ? ` (${p.count} times)` : ""}`);
      const orders = new Set(slips.map((x) => x.id)).size; // a split order has one slip per box
      const freshCount = orders - data.printed.length;
      const choice = await reprintChoice(data.printed.length === orders
        ? (orders === 1 ? `This order's packing slip${slips.length > 1 ? "s were" : " was"} already printed` : `All ${orders} orders' packing slips were already printed`)
        : `${data.printed.length} of ${orders} orders' packing slips were already printed`, lines, freshCount, "packing slip");
      if (choice === "cancel") return;
      if (choice === "new") slips = slips.filter((s) => !data.printed.some((p) => p.id === s.id));
    }
    toast(`Preparing ${slips.length} packing slip${slips.length === 1 ? "" : "s"}…`);
    const { slipToZpl } = await import("./zpl.js");
    const dpi = Number(printSettings().zebraDpi) || 203;
    const zpl = [];
    for (const s of slips) zpl.push(await slipToZpl(s.html, data.css, dpi));
    const device = await sendZpl(zpl.join("\n"));
    if (!sample) fetch("/api/shipping/packing-slips/printed", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: slips.map((s) => s.id) }) }).catch(() => {});
    toast(`${slips.length} packing slip${slips.length === 1 ? "" : "s"} sent to ${device.name || "the Zebra"}`);
  } catch (e) {
    // Never stuck at the packing station: offer the normal print dialog for the same slips
    const url = `/api/shipping/packing-slips?size=4x6&ids=${orderIds.map(encodeURIComponent).join(",")}`;
    actionToast(`Zebra didn't take it: ${e.message}`, "Print with dialog instead", () => window.open(url, "_blank"), 20000);
  }
}

export async function testZebra() {
  const zpl = "^XA^CF0,40^FO40,60^FDTuft the World^FS^CF0,30^FO40,120^FDZebra test label OK^FS^FO40,180^BY3^BCN,100,Y,N,N^FDTEST-1234^FS^XZ";
  return sendZpl(zpl);
}

// ---- Commercial invoice (international): letter size on a normal printer, in its own tab
const CI_COPIES = "ci_copies";
export function invoiceCopies() {
  try { return Math.min(5, Math.max(1, Number(localStorage.getItem(CI_COPIES)) || 3)); } catch { return 3; }
}
export function setInvoiceCopies(n) {
  try { localStorage.setItem(CI_COPIES, String(n)); } catch { /* private window */ }
}

/**
 * Opens the commercial invoice to print. Before the label: pass `body` (to, customs, orderName…);
 * after it: pass `shipmentId` (the invoice then carries the tracking number).
 */
export async function openCommercialInvoice({ body = null, shipmentId = null } = {}) {
  const copies = invoiceCopies();
  const w = window.open("about:blank", "_blank");
  if (!w) throw new Error("Allow pop-ups for this site to print the commercial invoice");
  w.document.write("<p style='font:14px system-ui;padding:20px'>Preparing the commercial invoice…</p>");
  try {
    const res = shipmentId
      ? await fetch(`/api/shipping/labels/${shipmentId}/invoice?copies=${copies}`, { credentials: "same-origin" })
      : await fetch("/api/shipping/commercial-invoice", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, copies }) });
    const html = await res.text();
    if (!res.ok) throw new Error((() => { try { return JSON.parse(html).error; } catch { return `Couldn't make the invoice (${res.status})`; } })());
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) {
    w.close();
    throw e;
  }
}
