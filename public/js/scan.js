// Packing station: scan the packing slip, scan each item to check it off, then verify & print.
import { api } from "./api.js";
import { h, mount, icon, money, toast, spinner } from "./ui.js";
import { labelFormat, openPackingSlips, printLabels, reserveWindow } from "./printing.js";

let audio;
function beep(ok) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.3));
  } catch { /* no audio */ }
}

const norm = (s) => String(s ?? "").trim().toLowerCase();
const WEIGHT_TO_LB = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 };
const lineLb = (l) => {
  const w = l.variant?.inventoryItem?.measurement?.weight;
  return w && w.value > 0 ? w.value * (WEIGHT_TO_LB[w.unit] ?? 1) : null;
};
const round1 = (n) => Math.round(n * 10) / 10;
const toAddress = (o) => {
  const a = o.draft?.to ?? null;
  if (a) return a;
  const s = o.shippingAddress || {};
  return { name: s.name || "", company: s.company || "", phone: s.phone || o.phone || "", address1: s.address1 || "", address2: s.address2 || "", city: s.city || "", state: s.provinceCode || "", zip: s.zip || "", country: s.countryCodeV2 || "US", residential: !s.company };
};
let presetsCache = null;

export function renderScan(root, { openSlideout }) {
  const st = { order: null, counts: new Map(), box: null, quote: null, qseq: 0 };
  const input = h("input", { class: "input scan-input", placeholder: "Scan a packing slip, or type an order number", autocomplete: "off", spellcheck: false, "aria-label": "Scan" });
  const area = h("div");
  mount(root, h("div", { class: "scan-layout" },
    h("div", { class: "card scan-card" },
      h("label", { class: "field" }, "Scanner", input),
      h("p", { class: "small muted", style: { margin: "8px 0 0" } }, "Barcode scanners type into this box and press Enter. Scan the order first, then each item.")),
    area));
  const focus = () => setTimeout(() => input.focus(), 0);
  focus();
  const onDocClick = (e) => { if (!e.target.closest("button, a, input, select, textarea")) focus(); };
  document.addEventListener("click", onDocClick);

  async function loadOrder(code) {
    mount(area, h("div", { class: "card loading" }, spinner()));
    try {
      const { order } = await api(`/shipping/scan/${encodeURIComponent(code)}`);
      st.order = order;
      st.counts = new Map(order.lineItems.nodes.map((l) => [l.id, 0]));
      presetsCache ??= (await api("/shipping/presets").catch(() => ({ presets: [] }))).presets;
      // The box this order is planned to go in (single-box orders can be changed right here)
      const b = order.plan.boxes?.length === 1 ? order.plan.boxes[0] : null;
      st.box = b ? { presetId: b.preset?.id ?? "", length: b.parcel.length, width: b.parcel.width, height: b.parcel.height, weight: order.plan.weightKnown ? b.parcel.weight : "", auto: false, changed: false } : null;
      st.quote = null;
      beep(true);
      draw();
      requote();
    } catch (e) {
      beep(false);
      st.order = null;
      mount(area, h("div", { class: "card notice bad" }, e.message));
    }
  }

  function scanItem(code) {
    const c = norm(code);
    const line = st.order.lineItems.nodes.find((l) => (norm(l.sku) === c || norm(l.variant?.barcode) === c) && st.counts.get(l.id) < l.quantity)
      ?? st.order.lineItems.nodes.find((l) => norm(l.sku) === c || norm(l.variant?.barcode) === c);
    if (!line) {
      beep(false);
      toast(`${code} isn't in ${st.order.name}`, true);
      return;
    }
    const n = st.counts.get(line.id);
    if (n >= line.quantity) {
      beep(false);
      toast(`Already scanned all ${line.quantity} × ${line.title}`, true);
      return;
    }
    st.counts.set(line.id, n + 1);
    beep(true);
    draw();
  }

  const allVerified = () => st.order && st.order.lineItems.nodes.every((l) => st.counts.get(l.id) >= l.quantity);
  const scannedAny = () => st.order && st.order.lineItems.nodes.some((l) => st.counts.get(l.id) > 0);
  const weightsKnown = () => st.order.lineItems.nodes.every((l) => lineLb(l) !== null);
  const tare = () => presetsCache?.find((p) => String(p.id) === String(st.box?.presetId))?.weight ?? 0;
  /** Box + these items, from Shopify product weights. */
  const itemsWeight = (qty) => round1(Math.max(0.1, tare() + st.order.lineItems.nodes.reduce((n, l) => n + qty(l) * lineLb(l), 0)));
  const parcelFor = (qty, contents) => ({
    length: +st.box.length, width: +st.box.width, height: +st.box.height,
    weight: qty && weightsKnown() ? itemsWeight(qty) : +st.box.weight,
    presetId: st.box.presetId ? Number(st.box.presetId) : undefined,
    box: presetsCache?.find((p) => String(p.id) === String(st.box.presetId))?.name,
    contents,
  });

  // Live rate for the box on screen (and margin against what the customer paid)
  async function requote() {
    const o = st.order;
    if (!o || !st.box) return;
    if (o.international) { st.quote = { note: "International — rates and customs on the order page (More options)" }; return drawQuote(); }
    if (!(+st.box.weight > 0) || !(+st.box.length > 0)) { st.quote = { note: "Enter the box size and weight for a rate" }; return drawQuote(); }
    const my = ++st.qseq;
    st.quote = { loading: true };
    drawQuote();
    try {
      const { rates } = await api("/shipping/rates", { method: "POST", body: { to: toAddress(o), parcels: [parcelFor(null)], signature: o.plan.signature || undefined } });
      if (my !== st.qseq) return;
      const want = o.plan.service;
      st.quote = { rate: rates.find((r) => r.serviceCode === want) ?? [...rates].sort((a, b) => a.total - b.total)[0] ?? null };
    } catch (e) {
      if (my === st.qseq) st.quote = { error: e.message };
    }
    drawQuote();
  }
  const quoteEl = h("span", { class: "scan-quote" });
  function drawQuote() {
    const q = st.quote;
    if (!q) return mount(quoteEl);
    if (q.loading) return mount(quoteEl, spinner());
    if (q.note) return mount(quoteEl, h("span", { class: "small muted" }, q.note));
    if (q.error) return mount(quoteEl, h("span", { class: "small neg" }, q.error));
    if (!q.rate) return mount(quoteEl, h("span", { class: "small muted" }, "No rate"));
    const m = st.order.shippingPaid - q.rate.total;
    mount(quoteEl, h("span", { class: "small" }, `${q.rate.serviceName} · `, h("b", {}, money(q.rate.total, q.rate.currency)), " · ", h("span", { class: "margin " + (m >= 0 ? "pos" : "neg") }, `${m >= 0 ? "+" : "−"}${money(Math.abs(m), "USD")} margin`)));
  }
  /** Saves the box so the queue, the order page and bulk buying use it too. */
  const saveBox = () => {
    const o = st.order;
    if (!o || !st.box) return;
    const items = Object.fromEntries(o.lineItems.nodes.map((l) => [l.id, l.quantity]));
    api(`/shipping/drafts/${encodeURIComponent(o.id)}`, { method: "PUT", body: { boxes: [{ presetId: st.box.presetId ? Number(st.box.presetId) : null, length: +st.box.length, width: +st.box.width, height: +st.box.height, weight: +st.box.weight || null, items }], signature: o.plan.signature, service: o.plan.service ?? null, to: o.draft?.to ?? null } }).catch(() => {});
  };
  let qtimer;
  const boxChanged = () => { st.box.changed = true; saveBox(); clearTimeout(qtimer); qtimer = setTimeout(requote, 500); };

  function boxRow() {
    const o = st.order;
    if (!st.box) {
      return h("div", { class: "scan-box" },
        h("span", { class: "small" }, `${o.plan.boxes.length} boxes: ${o.plan.boxes.map((b) => b.preset?.name ?? "custom").join(" + ")}`),
        h("button", { class: "btn sm", onclick: () => openSlideout(o) }, "Change boxes"));
    }
    const sel = h("select", { class: "input", "aria-label": "Box" }, h("option", { value: "" }, "Custom size"),
      (presetsCache ?? []).map((p) => h("option", { value: p.id, selected: String(p.id) === String(st.box.presetId) }, p.name)));
    const num = (key, label, step) => {
      const i = h("input", { class: "input", type: "number", min: "0", step, value: st.box[key], inputmode: "decimal", "aria-label": label });
      i.oninput = () => { st.box[key] = i.value; if (key !== "weight") st.box.presetId = ""; boxChanged(); if (key !== "weight") sel.value = ""; };
      return h("label", { class: "field" }, label, i);
    };
    const weightIn = num("weight", "Weight lb", "0.1");
    sel.onchange = () => {
      const p = (presetsCache ?? []).find((x) => String(x.id) === sel.value);
      const old = (presetsCache ?? []).find((x) => String(x.id) === String(st.box.presetId));
      st.box.presetId = sel.value;
      if (p) {
        Object.assign(st.box, { length: p.length, width: p.width, height: p.height });
        if (weightsKnown()) st.box.weight = itemsWeight((l) => l.quantity);
        else if (+st.box.weight > 0) st.box.weight = round1(Math.max(0.1, +st.box.weight - (old?.weight ?? 0) + (p.weight ?? 0)));
      }
      boxChanged();
      draw();
    };
    return h("div", { class: "scan-box" },
      h("label", { class: "field", style: { minWidth: "200px", flex: 2 } }, "Box", sel),
      num("length", "L in", "0.5"), num("width", "W in", "0.5"), num("height", "H in", "0.5"), weightIn,
      h("div", { class: "scan-quote-wrap" }, quoteEl, h("button", { class: "linkish small", onclick: () => openSlideout(o) }, "More options")));
  }

  function draw() {
    const o = st.order;
    if (!o) return mount(area);
    const verified = allVerified();
    const go = h("button", { class: "btn primary big" }, icon("printer"), verified ? "Verify & print label" : "Print label anyway");
    const missing = () => o.lineItems.nodes.filter((l) => st.counts.get(l.id) < l.quantity).map((l) => `${l.quantity - st.counts.get(l.id)} × ${l.title}`);
    const shipPart = !verified && scannedAny() ? h("button", { class: "btn big", title: "Out of stock? Ship the scanned items now; the rest of the order goes on hold" }, "Ship what's scanned") : null;
    const buy = async (btn, partial) => {
      btn.disabled = true;
      const win = reserveWindow();
      try {
        const qty = partial ? (l) => st.counts.get(l.id) : (l) => l.quantity;
        const body = { orderId: o.id, policy: "rule", labelFormat: labelFormat(), scanVerified: verified };
        if (partial) body.partial = o.lineItems.nodes.map((l) => ({ id: l.id, qty: st.counts.get(l.id) }));
        // The box on screen (when changed, or for a partial shipment with only the scanned items in it)
        if (st.box && (st.box.changed || partial)) {
          body.parcels = [parcelFor(partial ? qty : null, partial ? o.lineItems.nodes.filter((l) => qty(l) > 0).map((l) => ({ id: l.id, title: l.title, qty: qty(l) })) : undefined)];
        }
        const r = await api("/shipping/labels/auto", { method: "POST", body });
        await printLabels({ ids: [r.id] }, win);
        toast(`${o.name}: ${r.serviceName} · ${money(r.cost, r.currency)}`);
        beep(true);
        const left = partial ? missing() : [];
        st.order = null;
        mount(area, h("div", { class: "card success-card fade-in" }, h("h2", {}, partial ? `${o.name} partly shipped` : `${o.name} done`), h("p", {}, `${r.serviceName} · ${money(r.cost, r.currency)} · ${r.trackingNumbers[0] ?? ""}`),
          partial ? h("p", {}, `On hold until it can ship: ${left.join(", ")}.`) : null,
          partial ? h("button", { class: "btn", onclick: () => openPackingSlips([o.id], null, { shipment: r.id }) }, icon("printer"), "Packing slip for this box") : null,
          r.fulfillError ? h("div", { class: "notice bad" }, r.fulfillError) : null, h("p", { class: "small", style: { opacity: 0.8 } }, "Scan the next packing slip.")));
      } catch (e) {
        win?.close();
        beep(false);
        toast(e.message, true);
        btn.disabled = false;
      }
      focus();
    };
    go.onclick = () => {
      if (!verified && !confirm("Not every item has been scanned. Print the label for the whole order anyway?")) return;
      buy(go, false);
    };
    if (shipPart) shipPart.onclick = () => {
      if (!st.box) return openSlideout(o, { shipQty: Object.fromEntries(st.counts) }); // several boxes: choose on the order page
      if (!confirm(`Ship only what's been scanned?\n\nHeld back (the order goes on hold):\n${missing().join("\n")}\n\nShopify marks only the shipped items fulfilled.`)) return;
      buy(shipPart, true);
    };
    const blocked = o.hasLabel ? "This order already has a label." : o.hold ? `On hold: ${o.hold}` : o.paymentPending ? "Payment is still pending." : null;
    mount(area, h("div", { class: "card" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", {}, h("h2", { style: { fontSize: "20px" } }, o.name), h("div", { class: "small muted" }, `${o.shippingAddress?.name ?? ""} · ${o.requestedService || "—"} · paid ${money(o.shippingPaid, "USD")}`)),
        h("button", { class: "btn sm", onclick: () => openSlideout(o) }, "Open label builder")),
      blocked ? h("div", { class: "notice bad", style: { marginTop: "12px" } }, blocked) : null,
      h("div", { class: "scan-items" }, o.lineItems.nodes.map((l) => {
        const n = st.counts.get(l.id);
        const done = n >= l.quantity;
        const plus = h("button", { class: "btn sm ghost", title: "Count one without scanning", onclick: () => { if (n < l.quantity) { st.counts.set(l.id, n + 1); draw(); focus(); } } }, icon("plus"));
        return h("div", { class: "scan-item" + (done ? " done" : "") },
          h("span", { class: "tick" }, done ? icon("check") : null),
          l.image ? h("img", { src: l.image.url, alt: "" }) : h("div", { class: "ph" }),
          h("div", { style: { minWidth: 0, flex: 1 } }, h("b", {}, l.title), h("div", { class: "small muted" }, [l.variantTitle, l.sku && `SKU ${l.sku}`, l.variant?.barcode && `Barcode ${l.variant.barcode}`].filter(Boolean).join(" · "))),
          h("span", { class: "count" }, `${n} / ${l.quantity}`), plus);
      })),
      h("div", { class: "row", style: { marginTop: "14px", justifyContent: "space-between" } },
        h("div", { class: "small muted" },
          o.plan.signature ? "Signature required" : ""),
        blocked ? null : h("div", { class: "row" }, shipPart, (o.plan.weightKnown || (st.box && +st.box.weight > 0)) ? go : h("span", { class: "small muted" }, "Enter the weight to print")))));
    if (!blocked) area.querySelector(".scan-items")?.after(boxRow());
    drawQuote();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const code = input.value.trim();
    input.value = "";
    if (!code) return;
    // An order-looking code (e.g. 68762-TG, #1042) loads a new order; anything else is an item
    const looksLikeOrder = /^#?\d{3,}(-[a-z]+)?$/i.test(code);
    if (!st.order || (looksLikeOrder && !st.order.lineItems.nodes.some((l) => norm(l.sku) === norm(code) || norm(l.variant?.barcode) === norm(code)))) loadOrder(code);
    else scanItem(code);
  });

  return () => document.removeEventListener("click", onDocClick);
}
