import { api } from "./api.js";
import { navigate } from "./app.js";
import { h, mount, icon, money, shortDate, relTime, fullTime, toast, busy, spinner, skeletonRows } from "./ui.js";
import { labelFormat, openPackingSlips, printLabels, printSettings, reserveWindow } from "./printing.js";
import { renderScan } from "./scan.js";

const VIEWS = [
  ["ready", "Ready to ship"],
  ["priority", "Priority"],
  ["payment_pending", "Payment pending"],
  ["on_hold", "On hold"],
  ["international", "International"],
  ["all", "All open"],
];
const VIEW_FILTERS = {
  ready: (o) => !o.hold && !o.paymentPending && !o.hasLabel,
  priority: (o) => !o.hold && !o.paymentPending && !o.hasLabel && o.priority,
  payment_pending: (o) => o.paymentPending && !o.hasLabel,
  on_hold: (o) => !!o.hold && !o.hasLabel,
  international: (o) => o.international && !o.hasLabel,
  all: () => true,
};
const POLICIES = [
  ["rule", "Rules, else cheapest"],
  ["cheapest", "Cheapest"],
  ["fastest", "Fastest"],
  ["03", "UPS Ground"],
  ["12", "UPS 3 Day Select"],
  ["02", "UPS 2nd Day Air"],
  ["13", "UPS Next Day Air Saver"],
  ["01", "UPS Next Day Air"],
];
const EMPTY_TO = { name: "", company: "", phone: "", address1: "", address2: "", city: "", state: "", zip: "", country: "US", residential: true };

const lbOz = (lb) => {
  if (!(lb > 0)) return "—";
  const oz = Math.round(lb * 16);
  return oz >= 16 ? `${Math.floor(oz / 16)} lb${oz % 16 ? ` ${oz % 16} oz` : ""}` : `${oz} oz`;
};
const ago = (iso) => {
  const r = relTime(iso);
  return r === "now" ? "just now" : /\d[mhd]$/.test(r) ? `${r} ago` : r;
};
const newBatchId = () => `B${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

export function renderShipping(main) {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const tab = path.startsWith("/shipping/scan") ? "scan" : path.startsWith("/shipping/batches") || params.get("tab") === "history" ? "batches" : "queue";

  const body = h("div");
  const notices = h("div");
  const blank = h("button", { class: "btn sm", onclick: () => openSlideout(null) }, icon("plus"), "Blank label");
  const printerChip = h("a", { class: "badge plain", href: "/settings#printing", "data-link": "", title: "Printer for this computer — change in Settings", style: { textDecoration: "none" } },
    icon("printer"), printSettings().labels === "zebra" ? "Zebra printer" : "Browser printing");
  const tabLink = (id, href, label) => h("a", { class: "tab" + (tab === id ? " active" : ""), href, "data-link": "" }, label);
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", {}, h("h1", {}, "Shipping"), h("p", { class: "sub" }, "Orders waiting to ship, UPS labels, packing slips and the packing station.")),
        h("div", { class: "row" }, printerChip, blank)),
      h("nav", { class: "tabs-line", "aria-label": "Shipping" },
        tabLink("queue", "/shipping", "Orders"), tabLink("scan", "/shipping/scan", "Scan & pack"), tabLink("batches", "/shipping/batches", "Label batches")))),
    h("div", { class: "page-inner wide" }, notices, body)));

  api("/shipping/status").then((st) => {
    const n = [];
    if (st.demo) n.push(h("div", { class: "notice info" }, "Demo data — Shopify isn't connected, so these are sample orders."));
    if (!st.ups) n.push(h("div", { class: "notice info" }, "UPS isn't connected yet. Add your UPS keys in Settings → Credentials to get rates and buy labels."));
    else if (st.upsEnv !== "production") n.push(h("div", { class: "notice info" }, "UPS test mode: labels aren't billed. Switch Mode to production in Settings → Credentials when ready."));
    mount(notices, n.length ? h("div", { class: "stack", style: { marginBottom: "16px" } }, n) : null);
  }).catch(() => {});

  const cleanups = [];
  if (tab === "scan") cleanups.push(renderScan(body, { openSlideout: (o) => openSlideout(o) }));
  else if (tab === "batches") renderBatches(body);
  else cleanups.push(renderQueue(body, params));

  // A ticket's "Ship" button links here with ?order=
  const preselect = params.get("order");
  if (preselect) api(`/shipping/orders/${encodeURIComponent(preselect)}`).then(({ order }) => openSlideout(order, { ticketId: params.get("ticket") })).catch((e) => toast(e.message, true));

  return () => {
    cleanups.forEach((f) => f && f());
    closeSlideout();
  };
}

// ---------------------------------------------------------------- Queue

let queueApi = null; // lets the slideout refresh the queue after buying a label

function renderQueue(root, params) {
  const st = { view: params.get("view") || "ready", orders: [], counts: {}, selected: new Set(), q: "", searchResults: null };
  const chips = h("div", { class: "view-chips", role: "tablist" });
  const search = h("input", { class: "input", type: "search", placeholder: "Find any order — #, email or name", "aria-label": "Search orders" });
  const bulk = h("div", { class: "bulk-bar card", hidden: true });
  const progress = h("div");
  const tableWrap = h("div", { class: "card table-card" }, skeletonRows(5));
  mount(root, h("div", { class: "row", style: { marginBottom: "12px", alignItems: "flex-start" } }, chips, h("div", { class: "search", style: { marginLeft: "auto", minWidth: "260px" } }, icon("search"), search)),
    bulk, progress, tableWrap);

  const load = async () => {
    try {
      const r = await api("/shipping/queue");
      st.orders = r.orders;
      st.counts = r.counts;
      draw();
    } catch (e) {
      mount(tableWrap, h("div", { class: "empty" }, h("h2", {}, "Couldn't load orders"), h("p", {}, e.message)));
    }
  };
  queueApi = { reload: load };

  let t;
  search.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      st.q = search.value.trim();
      if (!st.q) { st.searchResults = null; draw(); return; }
      try { st.searchResults = (await api(`/shipping/orders?q=${encodeURIComponent(st.q)}`)).orders; draw(); }
      catch (e) { toast(e.message, true); }
    }, 300);
  });

  const visible = () => (st.searchResults ?? st.orders.filter(VIEW_FILTERS[st.view]));

  function draw() {
    mount(chips, VIEWS.map(([id, label]) => h("button", {
      class: "view-chip" + (st.view === id && !st.searchResults ? " active" : ""), role: "tab", "aria-selected": st.view === id,
      onclick: () => { st.view = id; st.selected.clear(); search.value = ""; st.searchResults = null; history.replaceState(null, "", `/shipping?view=${id}`); draw(); },
    }, label, h("span", { class: "n" }, st.counts[id] ?? 0))));
    const rows = visible();
    for (const id of [...st.selected]) if (!rows.some((o) => o.id === id)) st.selected.delete(id);
    drawBulk(rows);
    if (!rows.length) {
      mount(tableWrap, h("div", { class: "empty" }, h("h2", {}, st.searchResults ? "No matching orders" : st.view === "ready" ? "Nothing waiting to ship" : "Nothing here"),
        h("p", {}, st.searchResults ? "Try the order number (e.g. 68762), the customer's email or their name." : "Orders appear here as they come in from Shopify.")));
      return;
    }
    const all = rows.every((o) => st.selected.has(o.id));
    const allBox = h("input", { type: "checkbox", checked: all && rows.length > 0, "aria-label": "Select all" });
    allBox.indeterminate = !all && st.selected.size > 0;
    allBox.onchange = () => { rows.forEach((o) => (allBox.checked ? st.selected.add(o.id) : st.selected.delete(o.id))); draw(); };
    mount(tableWrap, h("div", { class: "tbl-wrap" }, h("table", { class: "tbl queue" },
      h("thead", {}, h("tr", {}, h("th", { class: "chk" }, allBox),
        ["Order", "Customer", "Items", "Weight", "Box", "Customer chose", "Paid", "Ship to", ""].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.map((o) => {
        const box = h("input", { type: "checkbox", checked: st.selected.has(o.id), "aria-label": `Select ${o.name}` });
        box.onclick = (e) => e.stopPropagation();
        box.onchange = () => { box.checked ? st.selected.add(o.id) : st.selected.delete(o.id); drawBulk(rows); tr.classList.toggle("sel", box.checked); };
        const a = o.shippingAddress || {};
        const tr = h("tr", { class: "click" + (st.selected.has(o.id) ? " sel" : ""), tabindex: 0, onclick: () => openSlideout(o), onkeydown: (e) => { if (e.key === "Enter") openSlideout(o); } },
          h("td", { class: "chk" }, box),
          h("td", {}, h("b", {}, o.name), h("div", { class: "small muted", title: fullTime(o.createdAt) }, ago(o.createdAt))),
          h("td", {}, a.name || o.email || "—"),
          h("td", {}, o.itemCount),
          h("td", { class: o.plan.weightKnown ? "" : "muted" }, o.plan.weightKnown ? lbOz(o.plan.parcel.weight) : "Needs weight"),
          h("td", {}, h("div", { class: "cell-box" }, o.plan.preset?.name ?? "Custom"),
            o.plan.source !== "default" ? h("div", { class: "small muted" }, o.plan.source === "rule" ? "by rule" : "remembered") : null),
          h("td", {}, o.requestedService || "—", o.priority ? h("span", { class: "badge warn plain", style: { marginLeft: "6px" } }, "Priority") : null),
          h("td", { class: "num" }, money(o.shippingPaid, "USD")),
          h("td", {}, [a.city, a.provinceCode].filter(Boolean).join(", "), o.international ? h("span", { class: "badge plain", style: { marginLeft: "6px" } }, a.countryCodeV2) : null),
          h("td", { class: "flags" },
            o.hold ? h("span", { class: "badge bad", title: o.hold }, "On hold") : null,
            o.paymentPending ? h("span", { class: "badge warn" }, "Payment pending") : null,
            o.hasLabel ? h("span", { class: "badge good" }, "Label bought") : null,
            o.slipPrinted ? h("span", { class: "badge plain", title: "Packing slip printed" }, "Slip printed") : null,
            o.plan.signature ? h("span", { class: "badge plain" }, o.plan.signature === "adult" ? "Adult sig." : "Signature") : null));
        return tr;
      })))));
  }

  function drawBulk(rows) {
    const picked = rows.filter((o) => st.selected.has(o.id));
    bulk.hidden = !picked.length;
    if (!picked.length) return;
    const policy = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Service for these labels" },
      POLICIES.map(([v, t]) => h("option", { value: v }, t)));
    const buy = h("button", { class: "btn primary" }, icon("printer"), `Buy ${picked.length} label${picked.length > 1 ? "s" : ""}`);
    buy.onclick = () => bulkBuy(picked, policy.value);
    const slips = h("button", { class: "btn" }, "Packing slips");
    slips.onclick = () => { openPackingSlips(picked.map((o) => o.id)); setTimeout(load, 1500); };
    const hold = h("button", { class: "btn" }, "Hold");
    hold.onclick = busy(hold, async () => {
      const note = prompt("Hold note (optional)", "") ?? null;
      if (note === null) return;
      await api("/shipping/holds", { method: "POST", body: { hold: true, note, orders: picked.map((o) => ({ id: o.id, name: o.name })) } });
      toast(`${picked.length} on hold`);
      st.selected.clear();
      load();
    });
    const release = h("button", { class: "btn" }, "Release");
    release.onclick = busy(release, async () => {
      await api("/shipping/holds", { method: "POST", body: { hold: false, orders: picked.map((o) => ({ id: o.id, name: o.name })) } });
      toast(`${picked.length} released`);
      st.selected.clear();
      load();
    });
    mount(bulk, h("b", {}, `${picked.length} selected`),
      h("div", { class: "row", style: { marginLeft: "auto" } }, h("span", { class: "small muted" }, "Service"), policy, buy, slips,
        picked.some((o) => !o.hold) ? hold : null, picked.some((o) => o.hold) ? release : null,
        h("button", { class: "btn ghost icon-only", "aria-label": "Clear selection", onclick: () => { st.selected.clear(); draw(); } }, icon("x"))));
  }

  /** Buys labels one order at a time (keeps each request small and shows progress), then prints the batch. */
  async function bulkBuy(picked, policy) {
    const ready = picked.filter((o) => !o.hasLabel && !o.hold);
    if (!ready.length) return toast("Those orders already have labels or are on hold", true);
    const total = ready.reduce((n, o) => n + (o.plan.weightKnown ? 0 : 1), 0);
    if (total && !confirm(`${total} order${total > 1 ? "s have" : " has"} no known weight and will be skipped. Continue?`)) return;
    const win = reserveWindow();
    const batch = newBatchId();
    const done = [];
    const failed = [];
    const bar = h("div", { class: "progress" }, h("i", { style: { width: "0%" } }));
    const status = h("div", { class: "small" });
    mount(progress, h("div", { class: "card", role: "status" }, h("div", { class: "row" }, spinner(), h("b", {}, "Buying labels…"), h("span", { class: "small muted" }, `Batch ${batch}`)), bar, status));
    for (const [i, o] of ready.entries()) {
      status.textContent = `${i + 1} of ${ready.length}: ${o.name}`;
      try {
        const r = await api("/shipping/labels/auto", { method: "POST", body: { orderId: o.id, policy, labelFormat: labelFormat(), batchId: batch } });
        done.push(r);
      } catch (e) {
        failed.push(`${o.name}: ${e.message}`);
      }
      bar.firstChild.style.width = `${Math.round(((i + 1) / ready.length) * 100)}%`;
    }
    const spend = done.reduce((n, r) => n + r.cost, 0);
    mount(progress, h("div", { class: "card" },
      h("h2", {}, `${done.length} label${done.length === 1 ? "" : "s"} bought`, done.length ? h("span", { class: "muted", style: { fontWeight: 500 } }, ` · ${money(spend, "USD")}`) : null),
      failed.length ? h("div", { class: "notice bad", style: { marginTop: "10px", whiteSpace: "pre-line" } }, `${failed.length} not bought:\n${failed.join("\n")}`) : null,
      h("div", { class: "row", style: { marginTop: "12px" } },
        done.length ? h("button", { class: "btn primary", onclick: () => printLabels({ batch }).catch((e) => toast(e.message, true)) }, icon("printer"), "Print again") : null,
        h("button", { class: "btn ghost", onclick: () => mount(progress) }, "Dismiss"))));
    if (done.length) await printLabels({ batch }, win).catch((e) => toast(e.message, true));
    else if (win) win.close();
    st.selected.clear();
    load();
  }

  load();
  return () => { queueApi = null; };
}

// ---------------------------------------------------------------- Slideout (one order)

let slide = null;

function closeSlideout() {
  if (!slide) return;
  slide.remove();
  document.removeEventListener("keydown", slide._esc);
  slide = null;
}

async function openSlideout(order, opts = {}) {
  closeSlideout();
  const panel = h("div", { class: "slide-body" });
  slide = h("div", { class: "slideout", role: "dialog", "aria-label": order ? `Ship ${order.name}` : "New label" },
    h("div", { class: "slide-scrim", onclick: closeSlideout }),
    h("aside", { class: "slide-panel" },
      h("div", { class: "slide-head" },
        h("h2", {}, order ? `Ship ${order.name}` : "New label"),
        h("button", { class: "btn ghost icon-only", "aria-label": "Close", onclick: closeSlideout }, icon("x"))),
      panel));
  slide._esc = (e) => { if (e.key === "Escape") closeSlideout(); };
  document.addEventListener("keydown", slide._esc);
  document.body.append(slide);
  mount(panel, skeletonRows(4));
  let presets = [];
  try {
    presets = (await api("/shipping/presets")).presets;
  } catch { /* fine */ }
  buildLabelForm(panel, order, presets, opts);
}

function buildLabelForm(root, o, presets, opts) {
  const plan = o?.plan;
  const a = o?.shippingAddress || {};
  const s = {
    to: o ? { name: a.name || "", company: a.company || "", phone: a.phone || o.phone || "", address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", state: a.provinceCode || "", zip: a.zip || "", country: a.countryCodeV2 || "US", residential: !a.company } : { ...EMPTY_TO },
    parcels: [],
    signature: plan?.signature || "",
    rates: [],
    rate: null,
    itemsLbs: o?.itemsWeight ?? 0,
  };
  const round1 = (n) => Math.round(n * 10) / 10;
  const defaultBox = presets.find((b) => b.is_default) ?? presets[0];
  if (plan) s.parcels = [{ preset: plan.preset?.id ?? "", ...plan.parcel, weight: plan.weightKnown ? plan.parcel.weight : "" }];
  else s.parcels = [{ preset: defaultBox?.id ?? "", length: defaultBox?.length ?? "", width: defaultBox?.width ?? "", height: defaultBox?.height ?? "", weight: "" }];
  const paid = o ? o.shippingPaid : null;

  const ratesEl = h("div");
  const resetRates = () => { s.rates = []; s.rate = null; drawRates(); };
  const field = (label, key, attrs = {}) => {
    const input = h("input", { class: "input", value: s.to[key] ?? "", ...attrs });
    input.addEventListener("input", () => { s.to[key] = input.value; resetRates(); });
    return h("label", { class: "field" }, label, input);
  };

  const parcelsEl = h("div", { class: "stack" });
  const drawParcels = () => mount(parcelsEl, s.parcels.map((p, i) => {
    const presetSel = h("select", { class: "input" },
      h("option", { value: "" }, "Custom size"),
      presets.map((b) => h("option", { value: b.id, selected: String(b.id) === String(p.preset) }, b.name + (b.is_default ? " (default)" : ""))));
    presetSel.onchange = () => {
      const b = presets.find((x) => String(x.id) === presetSel.value);
      const old = presets.find((x) => String(x.id) === String(p.preset));
      p.preset = presetSel.value;
      if (b) {
        Object.assign(p, { length: b.length, width: b.width, height: b.height });
        if (p.weight !== "" && !Number.isNaN(+p.weight)) p.weight = round1(Math.max(0.1, +p.weight - (old?.weight ?? 0) + (b.weight ?? 0)));
      }
      drawParcels();
      resetRates();
    };
    const num = (key, label) => {
      const inp = h("input", { class: "input", type: "number", min: "0", step: key === "weight" ? "0.1" : "0.5", value: p[key], inputmode: "decimal" });
      inp.oninput = () => { p[key] = inp.value; if (key !== "weight") p.preset = ""; resetRates(); };
      return h("label", { class: "field" }, label, inp);
    };
    return h("div", { class: "parcel" },
      h("label", { class: "field" }, s.parcels.length > 1 ? `Package ${i + 1}` : "Box", presetSel),
      num("length", "L in"), num("width", "W in"), num("height", "H in"), num("weight", "Weight lb"),
      s.parcels.length > 1 ? h("button", { class: "btn ghost sm icon-only", "aria-label": "Remove package", onclick: () => { s.parcels.splice(i, 1); drawParcels(); resetRates(); } }, icon("x")) : h("span"));
  }));
  drawParcels();

  const sigSel = h("select", { class: "input" },
    [["", "No signature"], ["standard", "Signature required"], ["adult", "Adult signature required"]].map(([v, t]) => h("option", { value: v, selected: s.signature === v }, t)));
  sigSel.onchange = () => { s.signature = sigSel.value; resetRates(); };

  const getRates = h("button", { class: "btn primary" }, "Get UPS rates");
  getRates.onclick = busy(getRates, async () => {
    mount(ratesEl, h("div", { class: "card" }, skeletonRows(3)));
    try {
      const { rates } = await api("/shipping/rates", { method: "POST", body: { to: s.to, parcels: s.parcels, signature: s.signature || undefined } });
      s.rates = rates;
      // Pre-pick what the rules asked for, else the cheapest
      const want = plan?.service;
      const fastest = [...rates].filter((r) => r.days).sort((x, y) => x.days - y.days || x.total - y.total)[0];
      s.rate = (want === "fastest" ? fastest : rates.find((r) => r.serviceCode === want)) ?? rates[0] ?? null;
      getRates.className = "btn";
      getRates.textContent = "Refresh rates";
    } catch (e) {
      mount(ratesEl, h("div", { class: "notice bad" }, e.message));
      return;
    }
    drawRates();
  });

  const holdBtn = o ? h("button", { class: "btn sm" }, o.hold ? "Release hold" : "Hold") : null;
  if (holdBtn) holdBtn.onclick = busy(holdBtn, async () => {
    const note = o.hold ? "" : prompt("Hold note (optional)", "");
    if (note === null) return;
    await api("/shipping/holds", { method: "POST", body: { hold: !o.hold, note, orders: [{ id: o.id, name: o.name }] } });
    toast(o.hold ? "Released" : "On hold");
    closeSlideout();
    queueApi?.reload();
  });

  mount(root,
    o ? h("div", { class: "slide-summary" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", { class: "small muted" }, `${shortDate(o.createdAt)} · ${money(o.totalPriceSet.shopMoney.amount, o.totalPriceSet.shopMoney.currencyCode)} · ${o.itemCount} item${o.itemCount === 1 ? "" : "s"}`),
        h("div", { class: "row" },
          h("button", { class: "btn sm", onclick: () => openPackingSlips([o.id]) }, "Packing slip"),
          holdBtn,
          h("a", { class: "btn sm ghost", href: o.adminUrl, target: "_blank", rel: "noopener" }, "Shopify", icon("ext")))),
      o.hold ? h("div", { class: "notice bad", style: { marginTop: "10px" } }, `On hold: ${o.hold}`) : null,
      h("div", { class: "paid-line" },
        h("div", {}, h("div", { class: "lbl" }, "Customer chose"), h("b", {}, o.requestedService || "—")),
        h("div", {}, h("div", { class: "lbl" }, "Customer paid for shipping"), h("b", {}, money(paid, "USD")))),
      plan?.rules?.matched?.length ? h("div", { class: "notice info", style: { marginTop: "10px" } }, icon("spark"), " Rules applied: ", plan.rules.matched.join(" · ")) : null,
      plan?.source === "learned" ? h("div", { class: "notice", style: { marginTop: "10px" } }, "Box and weight remembered from the last time these exact items shipped.") : null,
      h("div", { class: "stack", style: { marginTop: "12px" } }, o.lineItems.nodes.map((l) =>
        h("div", { class: "line" },
          l.image ? h("img", { src: l.image.url, alt: "" }) : h("div", { class: "ph" }),
          h("div", { style: { minWidth: 0 } }, h("div", {}, l.title), h("div", { class: "small muted" }, [l.variantTitle, l.sku].filter(Boolean).join(" · "))),
          h("span", { class: "qty" }, `× ${l.quantity}`))))) : h("p", { class: "muted small" }, "Not linked to an order — for replacements, samples, etc."),
    h("h3", { class: "section" }, "Ship to"),
    h("div", { class: "stack" },
      h("div", { class: "grid2" }, field("Name", "name"), field("Company", "company")),
      h("div", { class: "grid2" }, field("Address", "address1"), field("Apt / suite", "address2")),
      h("div", { class: "grid4" }, field("City", "city"), field("State", "state", { maxlength: 2 }), field("ZIP", "zip"), field("Country", "country", { maxlength: 2 })),
      h("div", { class: "grid2" }, field("Phone", "phone"), (() => {
        const r = h("input", { type: "checkbox", checked: s.to.residential });
        r.onchange = () => { s.to.residential = r.checked; resetRates(); };
        return h("label", { class: "check", style: { alignSelf: "end", paddingBottom: "8px" } }, r, "Residential address");
      })())),
    h("h3", { class: "section" }, "Package"),
    parcelsEl,
    h("div", { class: "row", style: { marginTop: "10px" } },
      h("label", { class: "field", style: { minWidth: "220px" } }, "Delivery signature", sigSel),
      h("button", { class: "btn sm ghost", style: { alignSelf: "end" }, onclick: () => { const last = s.parcels.at(-1) ?? {}; s.parcels.push({ ...last, weight: "" }); drawParcels(); resetRates(); } }, icon("plus"), "Add package"),
      h("div", { style: { flex: 1 } }),
      h("div", { style: { alignSelf: "end" } }, getRates)),
    ratesEl);

  function drawRates() {
    if (!s.rates.length) return mount(ratesEl);
    const cheapest = Math.min(...s.rates.map((r) => r.total));
    const timed = s.rates.filter((r) => r.days);
    const fastestDays = timed.length ? Math.min(...timed.map((r) => r.days)) : null;
    const fulfill = h("input", { type: "checkbox", checked: !!o });
    const notify = h("input", { type: "checkbox", checked: true });
    const buy = h("button", { class: "btn primary", style: { height: "40px", padding: "0 18px" } });
    const drawBuy = () => buy.replaceChildren(icon("printer"), s.rate ? `Buy & print · ${money(s.rate.total, s.rate.currency)}` : "Pick a service");
    drawBuy();
    buy.onclick = busy(buy, async () => {
      if (!s.rate) return;
      const win = reserveWindow();
      try {
        const r = await api("/shipping/labels", {
          method: "POST",
          body: {
            orderId: o?.id, ticketId: opts.ticketId ? Number(opts.ticketId) : undefined, to: s.to, parcels: s.parcels,
            presetId: s.parcels.length === 1 && s.parcels[0].preset ? Number(s.parcels[0].preset) : undefined,
            serviceCode: s.rate.serviceCode, serviceName: s.rate.serviceName, listTotal: s.rate.listTotal,
            labelFormat: labelFormat(), fulfill: fulfill.checked, notifyCustomer: notify.checked, signature: s.signature || undefined, batchId: newBatchId(),
          },
        });
        await printLabels({ ids: [r.id] }, win).catch((e) => toast(e.message, true));
        showPurchased(r);
        queueApi?.reload();
      } catch (e) {
        win?.close();
        throw e;
      }
    });
    mount(ratesEl, h("div", { class: "rates-card" },
      h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "8px" } },
        h("h3", { class: "section", style: { margin: 0 } }, "Service"),
        paid !== null ? h("span", { class: "small muted" }, `Margin = ${money(paid, "USD")} paid − label`) : null),
      h("div", { class: "rates", role: "radiogroup" }, s.rates.map((r) => {
        const margin = paid !== null ? paid - r.total : null;
        return h("div", {
          class: "rate" + (s.rate === r ? " sel" : ""), role: "radio", tabindex: 0, "aria-checked": s.rate === r,
          onclick: () => { s.rate = r; drawRates(); },
          onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); s.rate = r; drawRates(); } },
        },
          h("span", { class: "radio" }),
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontWeight: 700 } }, r.serviceName),
            h("div", { class: "row", style: { gap: "6px", marginTop: "2px" } },
              h("span", { class: "small muted" }, r.days ? `Est. ${r.days} business day${r.days > 1 ? "s" : ""}` : "Transit time varies"),
              r.total === cheapest ? h("span", { class: "badge plain" }, "Cheapest") : null,
              fastestDays !== null && r.days === fastestDays ? h("span", { class: "badge plain" }, "Fastest") : null,
              plan?.service === r.serviceCode ? h("span", { class: "badge plain" }, "By rule") : null)),
          h("div", { class: "price-col" },
            h("div", { class: "price" }, money(r.total, r.currency), r.listTotal > r.total ? h("span", { class: "list" }, money(r.listTotal, r.currency)) : null),
            margin !== null ? h("div", { class: "margin " + (margin >= 0 ? "pos" : "neg") }, `${margin >= 0 ? "+" : "−"}${money(Math.abs(margin), "USD")} margin`) : null));
      })),
      h("div", { class: "stack", style: { marginTop: "14px" } },
        o ? h("label", { class: "check" }, fulfill, "Mark the order fulfilled in Shopify with this tracking number") : null,
        o ? h("label", { class: "check" }, notify, "Email the customer their shipping confirmation (Shopify)") : null),
      h("div", { class: "buy-bar" }, h("span", { class: "small muted" }, printSettings().labels === "zebra" ? "Prints to your Zebra printer" : "Opens the 4×6 label to print"), buy)));
  }

  function showPurchased(r) {
    mount(ratesEl, h("div", { class: "card success-card fade-in" },
      h("h2", {}, "Label bought"),
      h("p", { style: { margin: "4px 0 12px", opacity: 0.85 } }, `${s.rate.serviceName} · ${money(r.cost, r.currency)}${o ? ` · ${o.name}` : ""}`),
      r.trackingNumbers.map((n) => h("div", { class: "tn" }, h("a", { href: `https://www.ups.com/track?tracknum=${n}`, target: "_blank", rel: "noopener" }, n))),
      r.fulfillError ? h("div", { class: "notice bad", style: { marginTop: "12px" } }, `The label is fine, but marking the order fulfilled in Shopify failed: ${r.fulfillError}`) : null,
      h("div", { class: "row", style: { marginTop: "16px" } },
        h("button", { class: "btn primary", onclick: () => printLabels({ ids: [r.id] }).catch((e) => toast(e.message, true)) }, icon("printer"), "Print again"),
        opts.ticketId ? h("a", { class: "btn", href: `/tickets/${opts.ticketId}`, "data-link": "", onclick: closeSlideout }, "Back to ticket") : null,
        h("button", { class: "btn", onclick: closeSlideout }, "Done"))));
  }
}

// ---------------------------------------------------------------- Batches

async function renderBatches(root) {
  mount(root, h("div", { class: "card" }, skeletonRows(4)));
  let batches;
  try {
    ({ batches } = await api("/shipping/batches"));
  } catch (e) {
    return mount(root, h("div", { class: "notice bad" }, e.message));
  }
  if (!batches.length) return mount(root, h("div", { class: "card empty" }, h("h2", {}, "No labels yet"), h("p", {}, "Every label you buy — one at a time or in bulk — shows up here for reprinting or voiding.")));
  const { labels } = await api("/shipping/labels");
  const byId = new Map(labels.map((l) => [String(l.id), l]));
  mount(root, h("div", { class: "card tbl-wrap", style: { padding: "6px 12px" } }, h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, ["Batch", "When", "Orders", "Labels", "Spend", "By", ""].map((x) => h("th", {}, x)))),
    h("tbody", {}, batches.flatMap((b) => {
      const ids = String(b.ids).split(",");
      const detail = h("tr", { class: "batch-detail", hidden: true }, h("td", { colspan: 7 }, h("table", { class: "tbl inner" }, h("tbody", {}, ids.map((id) => {
        const l = byId.get(id);
        if (!l) return null;
        const voidBtn = h("button", { class: "btn sm ghost danger" }, "Void");
        voidBtn.onclick = busy(voidBtn, async () => {
          if (!confirm("Void this label with UPS? You won't be charged for it.")) return;
          await api(`/shipping/labels/${l.id}/void`, { method: "POST" });
          toast("Label voided");
          renderBatches(root);
        });
        return h("tr", {},
          h("td", {}, l.order_name || "—"),
          h("td", {}, l.ship_to?.name, h("div", { class: "small muted" }, [l.ship_to?.city, l.ship_to?.state].filter(Boolean).join(", "))),
          h("td", {}, l.service_name, l.status === "voided" ? h("span", { class: "badge bad", style: { marginLeft: "6px" } }, "Voided") : null),
          h("td", { class: "mono" }, l.tracking_numbers.map((n) => h("div", {}, h("a", { href: `https://www.ups.com/track?tracknum=${n}`, target: "_blank", rel: "noopener" }, n)))),
          h("td", { class: "num" }, l.cost != null ? money(l.cost, l.currency) : ""),
          h("td", {}, l.status !== "voided" ? h("button", { class: "btn sm", onclick: () => printLabels({ ids: [l.id] }).catch((e) => toast(e.message, true)) }, "Print") : null, l.status !== "voided" ? voidBtn : null));
      })))));
      const toggle = h("button", { class: "btn sm ghost" }, "Details");
      toggle.onclick = () => { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? "Details" : "Hide"; };
      const reprint = h("button", { class: "btn sm" }, icon("printer"), "Reprint");
      reprint.onclick = () => (b.batch.startsWith("label-") ? printLabels({ ids }) : printLabels({ batch: b.batch })).catch((e) => toast(e.message, true));
      return [h("tr", {},
        h("td", { class: "mono" }, b.batch.startsWith("label-") ? "—" : b.batch),
        h("td", { title: new Date(b.created_at).toLocaleString() }, fullTime(b.created_at)),
        h("td", { style: { maxWidth: "260px" } }, b.orders || "—"),
        h("td", {}, b.labels, b.voided ? h("span", { class: "small muted" }, ` (${b.voided} voided)`) : null),
        h("td", { class: "num" }, money(b.cost || 0, "USD")),
        h("td", {}, b.agent_name || "—"),
        h("td", { style: { textAlign: "right", whiteSpace: "nowrap" } }, reprint, toggle)), detail];
    })))));
}
