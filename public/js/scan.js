// Packing station: scan the packing slip, scan each item to check it off, then verify & print.
import { api } from "./api.js";
import { h, mount, icon, money, toast, spinner } from "./ui.js";
import { labelFormat, printLabels, reserveWindow } from "./printing.js";

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

export function renderScan(root, { openSlideout }) {
  const st = { order: null, counts: new Map() };
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
      beep(true);
      draw();
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

  function draw() {
    const o = st.order;
    if (!o) return mount(area);
    const verified = allVerified();
    const go = h("button", { class: "btn primary big" }, icon("printer"), verified ? "Verify & print label" : "Print label anyway");
    go.onclick = async () => {
      if (!verified && !confirm("Not every item has been scanned. Print the label anyway?")) return;
      go.disabled = true;
      const win = reserveWindow();
      try {
        const r = await api("/shipping/labels/auto", { method: "POST", body: { orderId: o.id, policy: "rule", labelFormat: labelFormat(), scanVerified: verified } });
        await printLabels({ ids: [r.id] }, win);
        toast(`${o.name}: ${r.serviceName} · ${money(r.cost, r.currency)}`);
        beep(true);
        st.order = null;
        mount(area, h("div", { class: "card success-card fade-in" }, h("h2", {}, `${o.name} done`), h("p", {}, `${r.serviceName} · ${money(r.cost, r.currency)} · ${r.trackingNumbers[0] ?? ""}`),
          r.fulfillError ? h("div", { class: "notice bad" }, r.fulfillError) : null, h("p", { class: "small", style: { opacity: 0.8 } }, "Scan the next packing slip.")));
      } catch (e) {
        win?.close();
        beep(false);
        toast(e.message, true);
        go.disabled = false;
      }
      focus();
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
          `${(o.plan.boxes?.length ?? 1) > 1 ? `${o.plan.boxes.length} boxes: ${o.plan.boxes.map((b) => b.preset?.name ?? "custom").join(" + ")}` : `Box: ${o.plan.preset?.name ?? "custom"}`} · ${o.plan.weightKnown ? `${o.plan.totalWeight ?? o.plan.parcel.weight} lb` : "weight unknown — use the label builder"}`,
          o.plan.signature ? " · signature required" : ""),
        blocked || !o.plan.weightKnown ? null : go)));
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
