import { api } from "./api.js";
import { navigate } from "./app.js";
import { h, mount, icon, money, shortDate, relTime, fullTime, toast, busy, spinner, skeletonRows } from "./ui.js";
import { labelFormat, openPackingSlips, printLabels, printSettings, reserveWindow } from "./printing.js";
import { renderScan } from "./scan.js";
import { parseCsv } from "./settings-support.js";

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
  ["usps:GroundAdvantage", "USPS Ground Advantage"],
  ["usps:Priority", "USPS Priority Mail"],
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
  const blank = h("button", { class: "btn sm", onclick: () => openOrderPage(null) }, icon("plus"), "Blank label");
  const printerChip = h("a", { class: "badge plain", href: "/settings#printing", "data-link": "", title: "Printer for this computer — change in Settings", style: { textDecoration: "none" } },
    icon("printer"), printSettings().labels === "zebra" ? "Zebra printer" : "Browser printing");
  const tabLink = (id, href, label) => h("a", { class: "tab" + (tab === id ? " active" : ""), href, "data-link": "" }, label);
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", {}, h("h1", {}, "Shipping"), h("p", { class: "sub" }, "Orders waiting to ship, UPS and USPS labels, packing slips and the packing station.")),
        h("div", { class: "row" }, printerChip, blank)),
      h("nav", { class: "tabs-line", "aria-label": "Shipping" },
        tabLink("queue", "/shipping", "Orders"), tabLink("scan", "/shipping/scan", "Scan & pack"), tabLink("batches", "/shipping/batches", "Label batches")))),
    h("div", { class: "page-inner wide" }, notices, body)));

  api("/shipping/status").then((st) => {
    const n = [];
    if (st.demo) n.push(h("div", { class: "notice info" }, "Demo data — Shopify isn't connected, so these are sample orders."));
    if (!st.ups && !st.usps) n.push(h("div", { class: "notice info" }, "No carrier connected yet. Add your UPS or USPS (EasyPost) keys in Settings → Credentials to get rates and buy labels."));
    else if (st.ups && st.upsEnv !== "production") n.push(h("div", { class: "notice info" }, "UPS test mode: labels aren't billed. Switch Mode to production in Settings → Credentials when ready."));
    mount(notices, n.length ? h("div", { class: "stack", style: { marginBottom: "16px" } }, n) : null);
  }).catch(() => {});

  const cleanups = [];
  if (tab === "scan") cleanups.push(renderScan(body, { openSlideout: (o) => openOrderPage(o, { list: [] }) }));
  else if (tab === "batches") renderBatches(body);
  else cleanups.push(renderQueue(body, params));

  // A ticket's "Ship" button links here with ?order=
  const preselect = params.get("order");
  if (preselect) api(`/shipping/orders/${encodeURIComponent(preselect)}`).then(({ order }) => openOrderPage(order, { ticketId: params.get("ticket"), list: queueApi?.list() })).catch((e) => toast(e.message, true));

  return () => {
    cleanups.forEach((f) => f && f());
    closeOrderPage(true);
  };
}

// ---------------------------------------------------------------- Queue

let queueApi = null; // lets the order page refresh the queue after buying a label and step through it

/** UPS numbers start with 1Z; everything else here is USPS. */
const trackHref = (n) => (/^1Z/i.test(n) ? `https://www.ups.com/track?tracknum=${n}` : `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`);

const SOURCE_LABEL = { rule: "by rule", learned: "remembered", "learned-similar": "remembered (similar order)", saved: "your choice" };

/** The latest choices saved per order in this session (the queue's copy of an order can be older). */
const drafts = new Map();

// ---- Live carrier quotes for queue rows (cached per order + package, a few at a time)
const quoteCache = new Map();
const quoteKey = (o) => `${o.id}|${JSON.stringify(o.plan.parcels ?? [o.plan.parcel])}|${o.plan.signature ?? ""}`;
function pickRate(rates, policy, plan) {
  if (!rates?.length) return null;
  const want = policy === "rule" ? plan.service ?? "cheapest" : policy;
  if (want === "fastest") return [...rates].filter((r) => r.days).sort((a, b) => a.days - b.days || a.total - b.total)[0] ?? rates[0];
  if (want === "cheapest") return [...rates].sort((a, b) => a.total - b.total)[0];
  return rates.find((r) => r.serviceCode === want) ?? null;
}
function loadQuotes(orders, onEach) {
  const todo = orders.filter((o) => o.plan.weightKnown && !o.hasLabel && !quoteCache.has(quoteKey(o)));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const o = todo[i++];
      const key = quoteKey(o);
      quoteCache.set(key, { loading: true });
      try {
        const { rates } = await api("/shipping/rates", { method: "POST", body: { to: addressFromOrder(o), parcels: o.plan.parcels ?? [o.plan.parcel], signature: o.plan.signature || undefined, customs: o.international ? await customsFor(o) : undefined } });
        quoteCache.set(key, { rates });
      } catch (e) {
        quoteCache.set(key, { error: e.message });
      }
      onEach(o);
    }
  };
  return Promise.all([worker(), worker(), worker()]);
}

/** Customs list for an order: Shopify HS/origin, then remembered per-product details, then defaults. */
async function customsFor(o) {
  const key = (l) => (l.sku || `${l.title}${l.variantTitle ? " / " + l.variantTitle : ""}`).toLowerCase();
  const W = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 };
  const { settings, profiles } = await api("/shipping/customs", { method: "POST", body: { keys: o.lineItems.nodes.map(key) } });
  return {
    contents: settings.contents, dutiesPaidBy: settings.dutiesPaidBy, nonDelivery: settings.nonDelivery, signer: settings.signer,
    items: o.lineItems.nodes.map((l) => {
      const p = profiles[key(l)];
      const inv = l.variant?.inventoryItem;
      const w = inv?.measurement?.weight;
      return {
        productKey: key(l), lineId: l.id,
        description: (p?.description || l.title || settings.description).slice(0, 35),
        hsCode: (inv?.harmonizedSystemCode || p?.hs_code || settings.hsCode || "").replace(/\D/g, ""),
        origin: (inv?.countryCodeOfOrigin || p?.origin || settings.origin || "US").toUpperCase(),
        qty: l.quantity,
        unitValue: Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney.amount ?? 0),
        unitWeightLb: w && w.value > 0 ? w.value * (W[w.unit] ?? 1) : 0,
      };
    }),
  };
}

const addrCache = new Map();
function loadAddressChecks(orders, onEach) {
  const todo = orders.filter((o) => !o.hasLabel && !o.international && !addrCache.has(o.id));
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const o = todo[i++];
      addrCache.set(o.id, { loading: true });
      try {
        addrCache.set(o.id, await api("/shipping/verify-address", { method: "POST", body: { address: addressFromOrder(o) } }));
      } catch {
        addrCache.delete(o.id);
      }
      onEach(o);
    }
  };
  return Promise.all([worker(), worker()]);
}

function renderQueue(root, params) {
  const st = { view: params.get("view") || "ready", orders: [], counts: {}, selected: new Set(), q: "", searchResults: null, policy: "rule" };
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
  queueApi = { reload: load, list: () => visible(), find: (id) => st.orders.find((x) => x.id === id) };

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
        ["Order", "Customer", "Items", "Weight", "Box", "Customer chose", "Paid", "Best quote · margin", "Ship to", ""].map((x) => h("th", { class: x === "Paid" ? "num" : null }, x)))),
      h("tbody", {}, rows.map((o) => {
        const box = h("input", { type: "checkbox", checked: st.selected.has(o.id), "aria-label": `Select ${o.name}` });
        box.onclick = (e) => e.stopPropagation();
        box.onchange = () => { box.checked ? st.selected.add(o.id) : st.selected.delete(o.id); drawBulk(rows); tr.classList.toggle("sel", box.checked); };
        const a = o.shippingAddress || {};
        const tr = h("tr", { "data-order": o.id, class: "click" + (st.selected.has(o.id) ? " sel" : ""), tabindex: 0, onclick: () => openOrderPage(o), onkeydown: (e) => { if (e.key === "Enter") openOrderPage(o); } },
          h("td", { class: "chk" }, box),
          h("td", { class: "nowrap" }, h("b", {}, o.name), h("div", { class: "small muted", title: fullTime(o.createdAt) }, ago(o.createdAt))),
          h("td", {}, a.name || o.email || "—"),
          h("td", {}, o.itemCount),
          h("td", { class: "nowrap" + (o.plan.weightKnown ? "" : " muted") }, o.plan.weightKnown ? lbOz(o.plan.totalWeight ?? o.plan.parcel.weight) : "Needs weight"),
          h("td", {}, h("div", { class: "cell-box", title: (o.plan.boxes ?? []).map((b) => b.preset?.name ?? "Custom").join(" + ") },
              (o.plan.boxes?.length ?? 1) > 1 ? `${o.plan.boxes.length} boxes` : o.plan.preset?.name ?? "Custom"),
            o.plan.source !== "default" ? h("div", { class: "small muted" }, SOURCE_LABEL[o.plan.source] ?? "") : null),
          h("td", {}, o.requestedService || "—", o.priority ? h("span", { class: "badge warn plain", style: { marginLeft: "6px" } }, "Priority") : null),
          h("td", { class: "num" }, money(o.shippingPaid, "USD")),
          quoteCell(o),
          h("td", {}, h("div", {}, [a.city, a.provinceCode].filter(Boolean).join(", "), o.international ? h("span", { class: "badge plain", style: { marginLeft: "6px" } }, a.countryCodeV2) : null), addrCell(o)),
          h("td", { class: "flags" },
            o.hold ? h("span", { class: "badge bad", title: o.hold }, "On hold") : null,
            o.paymentPending ? h("span", { class: "badge warn" }, "Payment pending") : null,
            o.hasLabel ? h("span", { class: "badge good" }, "Label bought") : null,
            o.slipPrinted ? h("span", { class: "badge plain", title: "Packing slip printed" }, "Slip printed") : null,
            o.plan.signature ? h("span", { class: "badge plain" }, o.plan.signature === "adult" ? "Adult sig." : "Signature") : null));
        return tr;
      })))));
    refreshQuotes(rows);
    refreshAddresses(rows);
  }

  const cells = new Map();
  function quoteCell(o) {
    const td = h("td", { class: "quote" });
    cells.set(o.id, td);
    fillQuote(o, td);
    return td;
  }
  function fillQuote(o, td = cells.get(o.id)) {
    if (!td) return;
    if (o.hasLabel) return mount(td, h("span", { class: "muted small" }, "—"));
    if (!o.plan.weightKnown) return mount(td, h("span", { class: "muted small" }, "Needs weight"));
    const q = quoteCache.get(quoteKey(o));
    if (!q || q.loading) return mount(td, h("span", { class: "skel-inline" }));
    if (q.error) return mount(td, h("span", { class: "small neg", title: q.error }, "No quote"));
    const r = pickRate(q.rates, st.policy, o.plan);
    if (!r) return mount(td, h("span", { class: "small muted" }, "Service not offered"));
    const m = o.shippingPaid - r.total;
    td.title = q.rates.map((x) => `${x.serviceName}: ${money(x.total, "USD")} → ${marginText(o.shippingPaid - x.total)}`).join("\n");
    mount(td, h("div", { class: "q-line" }, h("span", { class: "small" }, r.serviceName.replace(/^USPS Priority Mail Express$/, "USPS Express").replace(/^USPS Priority Mail$/, "USPS Priority")), h("b", {}, money(r.total, "USD"))),
      h("div", { class: "margin " + (m >= 0 ? "pos" : "neg") }, `${marginText(m)} margin`));
  }
  const refreshQuotes = (rows) => loadQuotes(rows, (o) => { fillQuote(o); if (st.selected.has(o.id)) drawBulk(visible()); });

  // Address check badge under the city (each address is checked once and cached)
  const addrCells = new Map();
  function addrCell(o) {
    const el = h("div", { class: "addr-badge" });
    addrCells.set(o.id, el);
    fillAddr(o, el);
    return el;
  }
  function fillAddr(o, el = addrCells.get(o.id)) {
    if (!el) return;
    const r = addrCache.get(o.id);
    if (!r || r.loading || r.status === "unchecked" || o.hasLabel) return mount(el);
    const map = { valid: ["good", "check", "Verified"], corrected: ["warn", "spam", "Suggested fix"], ambiguous: ["warn", "spam", "Check address"], invalid: ["bad", "spam", "Address not found"] };
    const [tone, ic, text] = map[r.status] ?? [];
    if (!tone) return mount(el);
    el.title = r.message;
    mount(el, h("span", { class: `addr-pill ${tone}` }, icon(ic), text));
  }
  const refreshAddresses = (rows) => loadAddressChecks(rows, (o) => fillAddr(o));

  function drawBulk(rows) {
    const picked = rows.filter((o) => st.selected.has(o.id));
    bulk.hidden = !picked.length;
    if (!picked.length) return;
    const policy = h("select", { class: "input", style: { width: "auto" }, "aria-label": "Service for these labels" },
      POLICIES.map(([v, t]) => h("option", { value: v, selected: v === st.policy }, t)));
    policy.onchange = () => { st.policy = policy.value; for (const o of visible()) fillQuote(o); drawBulk(visible()); };
    const quoted = picked.map((o) => [o, pickRate(quoteCache.get(quoteKey(o))?.rates, st.policy, o.plan)]).filter(([, r]) => r);
    const est = quoted.reduce((n, [, r]) => n + r.total, 0);
    const estMargin = quoted.reduce((n, [o, r]) => n + (o.shippingPaid - r.total), 0);
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
      quoted.length ? h("span", { class: "small", title: quoted.length < picked.length ? "Some selected orders have no quote yet" : null },
        `Est. ${money(est, "USD")} · `, h("span", { class: "margin " + (estMargin >= 0 ? "pos" : "neg") }, `${marginText(estMargin)} margin`),
        quoted.length < picked.length ? h("span", { class: "muted" }, ` (${quoted.length} of ${picked.length} quoted)`) : null) : null,
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

// ---------------------------------------------------------------- Order page (one order, full window)

let page = null;

/** Removes ?order= from the address bar without leaving the Shipping page. */
function dropOrderParam() {
  const u = new URL(location.href);
  if (!u.searchParams.has("order")) return;
  u.searchParams.delete("order");
  u.searchParams.delete("ticket");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}

function closeOrderPage(keepUrl = false) {
  if (!page) return;
  page.el.remove();
  document.removeEventListener("keydown", page.keys, true);
  document.body.classList.remove("order-open");
  const id = page.orderId;
  page = null;
  if (keepUrl) return;
  dropOrderParam();
  if (queueApi?.stale) { queueApi.stale = false; queueApi.reload(); } // show the boxes chosen
  // Back on the queue, land on the row of the order last looked at
  const tr = [...document.querySelectorAll("tr[data-order]")].find((t) => t.dataset.order === id);
  if (tr) { tr.focus({ preventScroll: true }); tr.scrollIntoView({ block: "nearest" }); }
}

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

/**
 * Full-window view of one order: ship-to, packages, service and the order itself, with
 * previous/next through the orders listed in the queue (↑/↓ or K/J), Esc to close, Ctrl+P to buy.
 */
async function openOrderPage(order, opts = {}) {
  const list = order ? opts.list ?? queueApi?.list() ?? [] : [];
  const at = order ? list.findIndex((x) => x.id === order.id) : -1;
  const go = (step) => {
    const next = list[at + step];
    if (next) openOrderPage(queueApi?.find(next.id) ?? next, { list }); // the queue's copy is fresher after a purchase
  };
  closeOrderPage(true);

  if (order) {
    const u = new URL(location.href);
    u.searchParams.set("order", order.id);
    if (opts.ticketId) u.searchParams.set("ticket", opts.ticketId);
    else u.searchParams.delete("ticket");
    history.replaceState(null, "", u.pathname + u.search);
  }

  const navBtn = (step, ic, label, key) => h("button", { class: "btn sm icon-only", "aria-label": label, title: `${label} (${key})`, disabled: at < 0 || !list[at + step], onclick: () => go(step) }, icon(ic));
  const body = h("div", { class: "op-body" });
  const scroller = h("div", { class: "op-scroll" }, body);
  const el = h("div", { class: "order-page", role: "dialog", "aria-modal": "true", "aria-label": order ? `Order ${order.name}` : "New label" },
    h("div", { class: "op-bar" },
      h("nav", { class: "op-crumbs", "aria-label": "Breadcrumb" },
        h("button", { class: "linkish", onclick: () => closeOrderPage() }, "Shipping"),
        h("span", { class: "sep" }, "/"),
        h("span", {}, order ? order.name : "New label")),
      h("div", { class: "row op-nav" },
        at >= 0 ? h("span", { class: "small muted op-count" }, `${at + 1} / ${list.length}`) : null,
        at >= 0 ? navBtn(-1, "up", "Previous order", "↑") : null,
        at >= 0 ? navBtn(1, "down", "Next order", "↓") : null,
        h("button", { class: "btn sm", onclick: () => closeOrderPage() }, "Close", h("kbd", {}, "Esc")))),
    scroller);

  const keys = (e) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
      e.preventDefault();
      page?.buy?.();
      return;
    }
    if (e.key === "Escape") {
      if (document.querySelector(".pop, .modal")) return; // let an open menu or dialog close first
      if (typing(e)) return e.target.blur();
      e.preventDefault();
      closeOrderPage();
      return;
    }
    if (typing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); go(-1); }
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); go(1); }
  };
  document.addEventListener("keydown", keys, true);
  document.body.classList.add("order-open");
  document.body.append(el);
  page = { el, keys, buy: null, orderId: order?.id };
  el.tabIndex = -1;
  el.focus({ preventScroll: true });

  mount(body, skeletonRows(6));
  let presets = [];
  try {
    presets = (await api("/shipping/presets")).presets;
  } catch { /* fine */ }
  if (page?.el !== el) return; // moved on while loading
  buildLabelForm(body, order, presets, { ...opts, list });
}

const WEIGHT_TO_LB = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 };
const lineWeight = (l) => {
  const w = l.variant?.inventoryItem?.measurement?.weight;
  return w && w.value > 0 ? w.value * (WEIGHT_TO_LB[w.unit] ?? 1) : null;
};

export function addressFromOrder(o) {
  const a = o.shippingAddress || {};
  return { name: a.name || "", company: a.company || "", phone: a.phone || o.phone || "", address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", state: a.provinceCode || "", zip: a.zip || "", country: a.countryCodeV2 || "US", residential: !a.company };
}

/** Shown instead of rates when our own return address has no phone: add it here and carry on. */
function shipFromPhoneFix(message, done) {
  const input = h("input", { class: "input", type: "tel", placeholder: "e.g. (813) 555-0123", autocomplete: "tel", "aria-label": "Your business phone number" });
  const save = h("button", { class: "btn primary sm" }, "Save & get rates");
  save.onclick = busy(save, async () => {
    const r = await api("/shipping/ship-from/phone", { method: "POST", body: { phone: input.value } });
    toast(`Ship-from phone saved: ${r.phone}`);
    done();
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save.click(); });
  return h("div", { class: "notice info" },
    h("b", {}, message),
    h("div", { class: "row", style: { marginTop: "10px", gap: "8px", flexWrap: "nowrap" } }, input, save),
    h("div", { class: "small", style: { marginTop: "6px" } }, "Saved to Settings → Shipping, so you only do this once. Any format works — it's cleaned up for the carriers."));
}

const marginText = (m) => `${m >= 0 ? "+" : "−"}${money(Math.abs(m), "USD")}`;

function buildLabelForm(root, o, presets, opts) {
  const plan = o?.plan;
  const s = {
    to: o ? addressFromOrder(o) : { ...EMPTY_TO },
    parcels: [],
    signature: plan?.signature || "",
    rates: [],
    rate: null,
    wantCode: null,
  };
  const round1 = (n) => Math.round(n * 10) / 10;
  const lines = o ? o.lineItems.nodes.map((l) => ({ id: l.id, title: l.title + (l.variantTitle ? ` · ${l.variantTitle}` : ""), qty: l.quantity, lb: lineWeight(l), image: l.image?.url })) : [];
  const weightsKnown = lines.length > 0 && lines.every((l) => l.lb !== null);
  const defaultBox = presets.find((b) => b.is_default) ?? presets[0];
  const allIn = () => Object.fromEntries(lines.map((l) => [l.id, l.qty]));
  if (plan) {
    const boxes = plan.boxes?.length ? plan.boxes : [{ preset: plan.preset, parcel: plan.parcel, items: allIn() }];
    s.parcels = boxes.map((b) => ({
      preset: b.preset?.id ?? "", length: b.parcel.length, width: b.parcel.width, height: b.parcel.height,
      weight: plan.weightKnown ? b.parcel.weight : "",
      alloc: Object.fromEntries(lines.map((l) => [l.id, b.items?.[l.id] ?? 0])),
      auto: false,
    }));
  }
  else s.parcels = [{ preset: defaultBox?.id ?? "", length: defaultBox?.length ?? "", width: defaultBox?.width ?? "", height: defaultBox?.height ?? "", weight: "", alloc: allIn(), auto: false }];
  // Choices already made for this order (boxes, split, service, signature, address)
  const draft = o ? drafts.get(o.id) ?? o.draft : null;
  if (draft?.boxes?.length) {
    s.parcels = draft.boxes.map((b) => ({
      preset: b.presetId ?? "", length: b.length || "", width: b.width || "", height: b.height || "", weight: b.weight || "",
      alloc: Object.fromEntries(lines.map((l) => [l.id, b.items?.[l.id] ?? 0])), auto: false,
    }));
    // a line added to the order since goes in the first box
    for (const l of lines) if (!s.parcels.some((p) => p.alloc[l.id])) s.parcels[0].alloc[l.id] = l.qty;
    if (draft.signature !== undefined) s.signature = draft.signature || "";
    if (draft.service) s.wantCode = draft.service;
    if (draft.to) s.to = { ...s.to, ...draft.to };
  }

  // ---- Save choices as they're made, so moving to another order (or bulk buying) keeps them
  let saveTimer;
  const savedEl = h("span", { class: "small muted op-saved" });
  const draftNow = () => ({
    boxes: s.parcels.map((p) => ({ presetId: p.preset ? Number(p.preset) : null, length: +p.length || 0, width: +p.width || 0, height: +p.height || 0, weight: +p.weight || null, items: { ...p.alloc } })),
    signature: s.signature || undefined,
    service: s.rate?.serviceCode ?? s.wantCode ?? null,
    to: s.toEdited ? s.to : null,
  });
  const remember = () => {
    if (!o || s.bought) return;
    const d = draftNow();
    drafts.set(o.id, d);
    if (queueApi) queueApi.stale = true;
    savedEl.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api(`/shipping/drafts/${encodeURIComponent(o.id)}`, { method: "PUT", body: draftNow() });
        savedEl.textContent = "Saved for this order";
      } catch (e) {
        savedEl.textContent = "";
        toast(`Couldn't save your choices: ${e.message}`, true);
      }
    }, 600);
  };
  if (draft?.to) s.toEdited = true;
  if (draft) savedEl.textContent = "Your saved choices";
  const resetDraft = async () => {
    clearTimeout(saveTimer);
    await api(`/shipping/drafts/${encodeURIComponent(o.id)}`, { method: "DELETE" });
    drafts.delete(o.id);
    const { order } = await api(`/shipping/orders/${encodeURIComponent(o.id)}`);
    if (queueApi) queueApi.stale = true;
    openOrderPage(order, opts);
  };
  const paid = o ? o.shippingPaid : null;
  const split = () => s.parcels.length > 1;
  const boxWeight = (p) => presets.find((b) => String(b.id) === String(p.preset))?.weight ?? 0;
  /** Box weight + items allocated to it (only when every product has a Shopify weight). */
  const autoWeight = (p) => round1(Math.max(0.1, boxWeight(p) + lines.reduce((n, l) => n + (p.alloc[l.id] || 0) * l.lb, 0)));
  const reweigh = () => { if (weightsKnown) for (const p of s.parcels) if (p.auto) p.weight = autoWeight(p); };

  // ---- Rates load by themselves and refresh when anything that changes the price changes
  // ---- Customs (international): one line per product, remembered per product once entered
  const customsEl = h("div");
  const CONTENTS = [["merchandise", "Merchandise (sold)"], ["gift", "Gift"], ["sample", "Sample"], ["returned_goods", "Returned goods"], ["documents", "Documents"], ["other", "Other"]];
  const loadCustoms = async () => {
    if (!o || s.customs) return drawCustoms();
    try {
      s.customs = await customsFor(o);
    } catch (e) {
      toast(`Couldn't load customs defaults: ${e.message}`, true);
    }
    drawCustoms();
    quote(0);
  };
  const customsProblems = () => {
    const c = s.customs;
    if (!c) return [];
    const out = [];
    c.items.forEach((i, n) => { if (!i.description.trim()) out.push(`Item ${n + 1} needs a description`); });
    const by = {};
    for (const i of c.items) by[i.hsCode || "?"] = (by[i.hsCode || "?"] ?? 0) + i.qty * i.unitValue;
    for (const [code, v] of Object.entries(by)) if (v > 2500) out.push(`Items under HS ${code} total ${money(v, "USD")} — over $2,500 needs an export filing (AES) first`);
    return out;
  };
  function drawCustoms() {
    if (!isIntl()) return mount(customsEl);
    const c = s.customs;
    if (!c) return mount(customsEl, h("div", { class: "notice", style: { marginTop: "16px" } }, o ? "Loading customs details…" : "Customs: open this from an order to fill in the items."));
    const total = c.items.reduce((n, i) => n + i.qty * i.unitValue, 0);
    const onEdit = () => { quote(900); drawProblems(); };
    const sel = (key, options) => {
      const el = h("select", { class: "input" }, options.map(([v, t]) => h("option", { value: v, selected: c[key] === v }, t)));
      el.onchange = () => { c[key] = el.value; onEdit(); };
      return el;
    };
    const probEl = h("div");
    const drawProblems = () => {
      const p = customsProblems();
      mount(probEl, p.length ? h("div", { class: "notice bad", style: { marginTop: "10px" } }, p.map((x) => h("div", {}, x))) : null);
    };
    drawProblems();
    mount(customsEl, h("div", { class: "customs card" },
      h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "6px" } },
        h("b", {}, "Customs"), h("span", { class: "small muted" }, `Declared value ${money(total, "USD")}`)),
      h("p", { class: "small muted", style: { margin: "0 0 10px" } }, "Describe each item plainly (e.g. “Acrylic yarn”, “Tufting gun”). What you enter is remembered for next time. HS codes from Shopify are filled in automatically."),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl customs-tbl" },
        h("thead", {}, h("tr", {}, ["Item", "Customs description", "HS code", "Made in", "Qty", "Value each"].map((x) => h("th", {}, x)))),
        h("tbody", {}, c.items.map((i) => {
          const inp = (key, attrs = {}) => {
            const el = h("input", { class: "input", value: i[key] ?? "", ...attrs });
            el.oninput = () => { i[key] = attrs.type === "number" ? Number(el.value) || 0 : key === "origin" ? el.value.toUpperCase() : el.value; onEdit(); };
            return el;
          };
          const line = lines.find((l) => l.id === i.lineId);
          return h("tr", {},
            h("td", { class: "small" }, line?.title ?? i.description),
            h("td", {}, inp("description", { maxlength: 35, placeholder: "e.g. Acrylic yarn" })),
            h("td", {}, inp("hsCode", { inputmode: "numeric", placeholder: "Optional", maxlength: 10, style: { width: "110px" } })),
            h("td", {}, inp("origin", { maxlength: 2, style: { width: "56px" } })),
            h("td", { class: "num" }, i.qty),
            h("td", {}, inp("unitValue", { type: "number", min: "0", step: "0.01", style: { width: "90px" } })));
        })))),
      h("div", { class: "grid3", style: { marginTop: "10px" } },
        h("label", { class: "field" }, "Contents", sel("contents", CONTENTS)),
        h("label", { class: "field" }, "Duties & taxes paid by", sel("dutiesPaidBy", [["recipient", "Customer (on delivery)"], ["sender", "Us (UPS bills our account)"]])),
        h("label", { class: "field" }, "If it can't be delivered", sel("nonDelivery", [["return", "Return to us"], ["abandon", "Abandon"]]))),
      probEl));
  }

  const ratesEl = h("div");
  let seq = 0;
  let timer;
  const isIntl = () => (s.to.country || "US").trim().toUpperCase() !== "US";
  const ready = () => ["name", "address1", "city", "country", ...(["US", "CA"].includes((s.to.country || "US").toUpperCase()) ? ["state", "zip"] : [])].every((k) => String(s.to[k] ?? "").trim())
    && s.parcels.every((p) => +p.length > 0 && +p.width > 0 && +p.weight > 0)
    && (!isIntl() || !!s.customs);
  const quote = (delay = 600) => {
    clearTimeout(timer);
    drawTotalWeight();
    if (s.rate) s.wantCode = s.rate.serviceCode;
    if (!ready()) { s.rates = []; s.rate = null; drawRates(); return; }
    ratesEl.classList.add("refreshing");
    timer = setTimeout(fetchRates, delay);
  };
  async function fetchRates() {
    const my = ++seq;
    if (!s.rates.length) mount(ratesEl, h("div", { class: "rates-card" }, h("div", { class: "row small muted" }, spinner(), "Getting rates…")));
    try {
      const { rates } = await api("/shipping/rates", { method: "POST", body: { to: s.to, parcels: s.parcels.map(cleanParcel), signature: s.signature || undefined, customs: isIntl() ? s.customs : undefined } });
      if (my !== seq) return;
      s.rates = rates;
      const want = s.wantCode ?? plan?.service;
      const fastest = [...rates].filter((r) => r.days).sort((x, y) => x.days - y.days || x.total - y.total)[0];
      s.rate = (want === "fastest" ? fastest : rates.find((r) => r.serviceCode === want)) ?? rates[0] ?? null;
      drawRates();
    } catch (e) {
      if (my !== seq) return;
      s.rates = [];
      s.rate = null;
      if (/ship-from \(return\) address needs a phone/.test(e.message)) return mount(ratesEl, shipFromPhoneFix(e.message, () => quote(0)));
      mount(ratesEl, h("div", { class: "notice bad" }, e.message, " ", h("button", { class: "btn sm", onclick: () => quote(0) }, "Try again")));
    } finally {
      if (my === seq) ratesEl.classList.remove("refreshing");
    }
  }
  const cleanParcel = (p) => ({
    length: p.length, width: p.width, height: p.height, weight: p.weight,
    presetId: p.preset ? Number(p.preset) : undefined,
    box: presets.find((b) => String(b.id) === String(p.preset))?.name,
    contents: split() ? lines.filter((l) => p.alloc[l.id] > 0).map((l) => ({ id: l.id, title: l.title, qty: p.alloc[l.id] })) : undefined,
  });

  const inputs = {};
  const field = (label, key, attrs = {}) => {
    const input = h("input", { class: "input", value: s.to[key] ?? "", ...attrs });
    inputs[key] = input;
    input.addEventListener("input", () => { s.to[key] = input.value; s.toEdited = true; remember(); if (key === "country") loadCustoms(); quote(900); verifySoon(1200); });
    return h("label", { class: "field" }, label, input);
  };

  // ---- Address check (UPS Address Validation, or EasyPost): verified / suggested fix / not found
  const addrEl = h("div", { class: "addr-check" });
  let resBox = null;
  let resTouched = false;
  let vseq = 0;
  let vtimer;
  const fmtAddr = (a) => [a.address1, a.address2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ");
  const applyAddress = (a) => {
    for (const k of ["address1", "address2", "city", "state", "zip", "country"]) {
      s.to[k] = a[k] ?? "";
      if (inputs[k]) inputs[k].value = s.to[k];
    }
    toast("Address updated for this label");
    s.toEdited = true;
    remember();
    quote(0);
    verifySoon(0);
  };
  const drawCheck = (r) => {
    s.addr = r;
    if (!r) return mount(addrEl);
    if (r.residential !== null && r.residential !== undefined && !resTouched && resBox) {
      if (s.to.residential !== r.residential) { s.to.residential = r.residential; resBox.checked = r.residential; quote(0); }
    }
    const kind = { valid: "good", corrected: "warn", ambiguous: "warn", invalid: "bad", unchecked: "muted" }[r.status] ?? "muted";
    const recheck = h("button", { class: "btn sm ghost", onclick: () => verifySoon(0, true) }, "Check again");
    mount(addrEl, h("div", { class: `addr-note ${kind}` },
      h("div", { class: "row", style: { gap: "8px", flexWrap: "nowrap", alignItems: "flex-start" } },
        icon(r.status === "valid" ? "check" : r.status === "unchecked" ? "info" : "spam"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("b", {}, r.message),
          r.residential !== null && r.residential !== undefined && r.status !== "invalid" ? h("span", { class: "small" }, ` · ${r.residential ? "residential" : "business"} address`) : null,
          r.status === "invalid" ? h("div", { class: "small" }, "Double-check it with the customer before buying a label — a wrong address costs a correction fee or a return.") : null,
          r.status === "corrected" && r.suggestion ? h("div", { class: "suggest" }, h("span", { class: "small" }, "Suggested: "), h("b", {}, fmtAddr(r.suggestion)),
            h("button", { class: "btn sm", onclick: () => applyAddress(r.suggestion) }, "Use this address")) : null,
          r.status === "ambiguous" ? h("div", { class: "stack", style: { gap: "4px", marginTop: "6px" } }, (r.candidates ?? [r.suggestion]).filter(Boolean).map((cand) =>
            h("button", { class: "btn sm ghost cand", onclick: () => applyAddress(cand) }, fmtAddr(cand)))) : null),
        r.status !== "valid" ? recheck : null)));
  };
  const verifySoon = (delay = 800, fresh = false) => {
    clearTimeout(vtimer);
    vtimer = setTimeout(async () => {
      const my = ++vseq;
      if (!s.to.address1 || !s.to.city || !s.to.zip) return drawCheck(null);
      try {
        const r = await api("/shipping/verify-address", { method: "POST", body: { address: s.to, fresh } });
        if (my === vseq) drawCheck(r);
      } catch (e) {
        if (my === vseq) drawCheck({ status: "unchecked", residential: null, message: e.message });
      }
    }, delay);
  };

  // ---- Items & boxes: the boxes across the top, every item below with which box it goes in
  const boxesEl = h("div", { class: "pack-boxes" });
  const itemsEl = h("div");
  const packHeadEl = h("div", { class: "row", style: { gap: "8px" } });
  const lineInfo = new Map((o?.lineItems.nodes ?? []).map((l) => [l.id, l]));
  const inBox = (p) => lines.reduce((n, l) => n + (p.alloc[l.id] || 0), 0);
  const left = (l) => l.qty - s.parcels.reduce((n, p) => n + (p.alloc[l.id] || 0), 0);
  const changed = () => { reweigh(); drawParcels(); quote(); remember(); };

  /** Puts n of an item in box i and takes the difference out of the other boxes (or hands it back). */
  const setQty = (l, i, n) => {
    n = Math.max(0, Math.min(l.qty, Math.round(+n || 0)));
    if (weightsKnown) for (const p of s.parcels) p.auto = true; // contents changed, so recompute each box's weight
    const target = s.parcels[i];
    let diff = n - (target.alloc[l.id] || 0);
    target.alloc[l.id] = n;
    const others = s.parcels.filter((_, j) => j !== i);
    if (diff > 0) {
      // take from whichever boxes hold the most of it
      for (const p of [...others].sort((a, b) => (b.alloc[l.id] || 0) - (a.alloc[l.id] || 0))) {
        const take = Math.min(diff, p.alloc[l.id] || 0);
        p.alloc[l.id] = (p.alloc[l.id] || 0) - take;
        diff -= take;
        if (!diff) break;
      }
    } else if (diff < 0 && others.length) {
      // units taken out go to the next box so nothing is left unpacked
      const to = s.parcels[(i + 1) % s.parcels.length];
      to.alloc[l.id] = (to.alloc[l.id] || 0) - diff;
    }
    changed();
  };

  /** What the chosen service charges for box i (multi-box only). */
  const boxCostText = (i) => (split() && s.rate?.perBox?.length === s.parcels.length ? money(s.rate.perBox[i], s.rate.currency) : "");
  const drawBoxCosts = () => boxesEl.querySelectorAll(".box-cost").forEach((el) => (el.textContent = boxCostText(Number(el.dataset.box))));
  const drawBoxes = () => {
    mount(boxesEl, s.parcels.map((p, i) => {
      const presetSel = h("select", { class: "input", "aria-label": `Box ${i + 1} size` },
        h("option", { value: "" }, "Custom size"),
        presets.map((b) => h("option", { value: b.id, selected: String(b.id) === String(p.preset) }, b.name + (b.is_default ? " (default)" : ""))));
      presetSel.onchange = () => {
        const b = presets.find((x) => String(x.id) === presetSel.value);
        const old = presets.find((x) => String(x.id) === String(p.preset));
        p.preset = presetSel.value;
        if (b) {
          Object.assign(p, { length: b.length, width: b.width, height: b.height });
          if (p.auto) p.weight = autoWeight(p);
          else if (p.weight !== "" && !Number.isNaN(+p.weight)) p.weight = round1(Math.max(0.1, +p.weight - (old?.weight ?? 0) + (b.weight ?? 0)));
        }
        drawParcels();
        quote();
        remember();
      };
      const num = (key, label) => {
        const inp = h("input", { class: "input", type: "number", min: "0", step: key === "weight" ? "0.1" : "0.5", value: p[key], inputmode: "decimal" });
        inp.oninput = () => { p[key] = inp.value; if (key !== "weight") p.preset = ""; else p.auto = false; quote(); remember(); };
        return h("label", { class: "field" }, key === "weight" && p.auto ? h("span", { title: "Box + the items in it, from Shopify product weights" }, "Weight lb · auto") : label, inp);
      };
      const n = inBox(p);
      return h("div", { class: "pack-box" + (split() ? " multi" : "") },
        h("div", { class: "pack-box-head" },
          h("b", {}, split() ? `Box ${i + 1}` : "Box"),
          lines.length && split() ? h("span", { class: "small muted" }, `${n} item${n === 1 ? "" : "s"}`) : null,
          split() ? h("b", { class: "box-cost", "data-box": i }, boxCostText(i)) : null,
          split() ? h("button", { class: "btn ghost sm icon-only", style: { marginLeft: "auto" }, "aria-label": `Remove box ${i + 1}`, title: "Remove this box (its items go to another box)", onclick: () => removeBox(i) }, icon("x")) : null),
        presetSel,
        h("div", { class: "pack-dims" }, num("length", "L in"), num("width", "W in"), num("height", "H in"), num("weight", "Weight lb")));
    }),
    h("button", { class: "pack-add", onclick: addBox, title: "Too much for one box? Each box gets its own label and tracking number." }, icon("plus"), h("span", {}, "Add another box")));
  };

  const drawItems = () => {
    const anyLeft = lines.some((l) => left(l) !== 0);
    const hasDraft = o && (drafts.has(o.id) || o.draft);
    mount(packHeadEl,
      savedEl,
      hasDraft ? h("button", { class: "btn sm ghost", title: "Forget the choices made here and go back to the suggested boxes", onclick: resetDraft }, "Reset") : null,
      totalWeightEl,
      split() && anyLeft ? h("span", { class: "badge warn" }, "Some items aren't in a box") : null,
      split() && lines.length ? h("button", { class: "btn sm", title: "Spread the items so each box weighs about the same", onclick: () => { splitEvenly(); changed(); } }, "Split evenly") : null);
    if (!lines.length) return mount(itemsEl);
    const meta = (l) => {
      const src = lineInfo.get(l.id);
      const each = src ? (src.discountedUnitPriceAfterAllDiscountsSet ? Number(src.discountedUnitPriceAfterAllDiscountsSet.shopMoney.amount) : null) : null;
      return { sub: [src?.variantTitle, src?.sku].filter(Boolean).join(" · "), price: each !== null ? money(each * l.qty, cur) : null, title: src?.title ?? l.title };
    };
    const head = (l) => {
      const m = meta(l);
      return [
        l.image ? h("img", { src: l.image, alt: "" }) : h("div", { class: "ph" }),
        h("div", { class: "pack-item-text" }, h("div", { class: "op-item-title" }, m.title), m.sub ? h("div", { class: "small muted" }, m.sub) : null),
        h("div", { class: "qty" }, h("span", { class: l.qty > 1 ? "many" : null }, `× ${l.qty}`), m.price ? h("div", { class: "small" }, m.price) : null),
      ];
    };
    if (!split()) {
      return mount(itemsEl, h("div", { class: "op-items" }, lines.map((l) => h("div", { class: "line" }, head(l)))));
    }
    mount(itemsEl, h("div", { class: "pack-rows" }, lines.map((l) => {
      const assign = l.qty === 1
        ? h("div", { class: "seg", role: "radiogroup", "aria-label": `Box for ${l.title}` }, s.parcels.map((p, i) =>
          h("button", { class: p.alloc[l.id] ? "on" : "", role: "radio", "aria-checked": !!p.alloc[l.id], onclick: () => setQty(l, i, 1) }, `Box ${i + 1}`)))
        : h("div", { class: "pack-qtys" }, s.parcels.map((p, i) => {
          const inp = h("input", { class: "input qty-in", type: "number", min: "0", max: String(l.qty), value: p.alloc[l.id] || 0, inputmode: "numeric", "aria-label": `${l.title} in box ${i + 1}` });
          inp.onchange = () => setQty(l, i, inp.value);
          return h("label", {}, h("span", { class: "small muted" }, `Box ${i + 1}`), inp);
        }));
      return h("div", { class: "pack-row" + (left(l) ? " short" : "") },
        h("div", { class: "line" }, head(l)),
        h("div", { class: "pack-assign" }, assign, left(l) ? h("span", { class: "small neg" }, `${left(l)} not in a box`) : null));
    })));
  };

  const drawParcels = () => {
    drawBoxes();
    drawItems();
  };
  const addBox = () => {
    const last = s.parcels.at(-1) ?? {};
    s.parcels.push({ preset: last.preset ?? "", length: last.length, width: last.width, height: last.height, weight: "", alloc: Object.fromEntries(lines.map((l) => [l.id, 0])), auto: weightsKnown });
    if (s.parcels.length === 2 && weightsKnown) s.parcels[0].auto = true;
    if (lines.length) splitEvenly();
    changed();
  };
  const removeBox = (i) => {
    const [gone] = s.parcels.splice(i, 1);
    const to = s.parcels[Math.max(0, i - 1)];
    for (const l of lines) to.alloc[l.id] = (to.alloc[l.id] || 0) + (gone.alloc[l.id] || 0); // its items go to the box before it
    changed();
  };
  /** Deal units out so each box gets about the same weight (heaviest units first). */
  const splitEvenly = () => {
    const units = lines.flatMap((l) => Array.from({ length: l.qty }, () => l)).sort((a, b) => (b.lb ?? 1) - (a.lb ?? 1));
    const load = s.parcels.map(() => 0);
    for (const p of s.parcels) for (const l of lines) p.alloc[l.id] = 0;
    for (const u of units) {
      const i = load.indexOf(Math.min(...load));
      s.parcels[i].alloc[u.id]++;
      load[i] += u.lb ?? 1;
    }
  };

  const sigSel = h("select", { class: "input" },
    [["", "No signature"], ["standard", "Signature required"], ["adult", "Adult signature required"]].map(([v, t]) => h("option", { value: v, selected: s.signature === v }, t)));
  sigSel.onchange = () => { s.signature = sigSel.value; quote(0); remember(); };

  const holdBtn = o ? h("button", { class: "btn sm" }, o.hold ? "Release hold" : "Hold") : null;
  if (holdBtn) holdBtn.onclick = busy(holdBtn, async () => {
    const note = o.hold ? "" : prompt("Hold note (optional)", "");
    if (note === null) return;
    await api("/shipping/holds", { method: "POST", body: { hold: !o.hold, note, orders: [{ id: o.id, name: o.name }] } });
    toast(o.hold ? "Released" : "On hold");
    o.hold = o.hold ? null : note || "On hold";
    queueApi?.reload();
    openOrderPage(o, opts);
  });

  // ---- Layout: summary + buy across the top, ship-to/service | packages, then items/customs; order details on the right
  const buyEl = h("div", { class: "card op-buy" });
  const amount = (set) => (set?.shopMoney ? Number(set.shopMoney.amount) : null);
  const cur = o?.totalPriceSet.shopMoney.currencyCode ?? "USD";
  const kv = (label, value) => (value === null || value === undefined || value === "" ? null : h("div", { class: "kv" }, h("span", {}, label), h("b", {}, value)));
  const totalWeightEl = h("span", { class: "small muted" });
  const drawTotalWeight = () => {
    const w = s.parcels.reduce((n, p) => n + (+p.weight || 0), 0);
    totalWeightEl.textContent = w > 0 ? `Total ${lbOz(w)}${split() ? ` · ${s.parcels.length} boxes` : ""}` : "";
  };
  const items = o?.lineItems.nodes ?? [];
  const notices = [
    o?.hold ? h("div", { class: "notice bad" }, `On hold: ${o.hold}`) : null,
    o?.hasLabel ? h("div", { class: "notice" }, "This order already has a label. Buying another one ships it again.") : null,
    plan?.rules?.matched?.length ? h("div", { class: "notice info" }, icon("spark"), " Rules applied: ", plan.rules.matched.join(" · ")) : null,
    plan?.source === "learned" ? h("div", { class: "notice" }, icon("spark"), " ",
      (plan.boxes?.length ?? 1) > 1 ? `Packed like last time these exact items shipped: ${plan.boxes.length} boxes, same split and weights.` : "Box and weight remembered from the last time these exact items shipped.") : null,
    plan?.source === "learned-similar" ? h("div", { class: "notice" }, icon("spark"), " Box remembered from an order with the same products in different quantities — check the weight.") : null,
  ].filter(Boolean);

  const shipTo = h("section", { class: "card op-card" },
    h("div", { class: "op-card-head" }, h("h3", {}, "Ship to"), o ? h("span", { class: "small muted" }, "Changes apply to this label only") : null),
    addrEl,
    h("div", { class: "stack" },
      h("div", { class: "grid3" }, field("Name", "name"), field("Company", "company"), field("Phone", "phone", { type: "tel" })),
      h("div", { class: "grid-street" }, field("Address", "address1"), field("Apt / suite", "address2")),
      h("div", { class: "grid-addr" }, field("City", "city"), field("State", "state", { maxlength: 2 }), field("ZIP", "zip"), field("Country", "country", { maxlength: 2 })),
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        (() => {
          const r = h("input", { type: "checkbox", checked: s.to.residential });
          resBox = r;
          r.onchange = () => { s.to.residential = r.checked; resTouched = true; s.toEdited = true; quote(0); remember(); };
          return h("label", { class: "check" }, r, "Residential address");
        })(),
        h("label", { class: "field", style: { minWidth: "200px" } }, "Delivery signature", sigSel))));

  const packages = h("section", { class: "card op-card" },
    h("div", { class: "op-card-head" }, h("h3", {}, o ? `Items & boxes · ${o.itemCount} item${o.itemCount === 1 ? "" : "s"}` : "Packages"), packHeadEl),
    boxesEl,
    itemsEl);

  const service = h("section", { class: "card op-card" }, ratesEl);

  const noteCard = o?.note ? h("section", { class: "card op-card" }, h("h3", {}, "Order note"), h("p", { class: "op-note" }, o.note)) : null;

  const a = o?.shippingAddress || {};
  const aside = o ? h("aside", { class: "op-aside" },
    h("section", { class: "card op-card" },
      h("h3", {}, "Order summary"),
      kv("Order", o.name),
      kv("Placed", fullTime(o.createdAt)),
      kv("Customer", a.name || null),
      kv("Email", o.email ? h("a", { href: `mailto:${o.email}` }, o.email) : null),
      kv("Phone", o.phone || a.phone || null),
      kv("Payment", o.displayFinancialStatus ? o.displayFinancialStatus.replace(/_/g, " ").toLowerCase() : null),
      kv("Customer chose", o.requestedService || "—"),
      o.tags?.length ? h("div", { class: "op-tags" }, o.tags.map((t) => h("span", { class: "badge plain" }, t))) : null,
      h("div", { class: "row", style: { marginTop: "12px", gap: "6px" } },
        h("button", { class: "btn sm", onclick: () => openPackingSlips([o.id]) }, "Packing slip"),
        holdBtn,
        h("a", { class: "btn sm ghost", href: o.adminUrl, target: "_blank", rel: "noopener" }, "Shopify", icon("ext")))),
    h("section", { class: "card op-card" },
      h("h3", {}, "Payment summary"),
      kv("Products", amount(o.subtotalPriceSet) !== null ? money(amount(o.subtotalPriceSet) + (amount(o.totalDiscountsSet) ?? 0), cur) : null),
      amount(o.totalDiscountsSet) ? kv("Discounts", `−${money(amount(o.totalDiscountsSet), cur)}`) : null,
      kv("Shipping paid", money(paid, cur)),
      amount(o.totalTaxSet) !== null ? kv("Tax", money(amount(o.totalTaxSet), cur)) : null,
      h("div", { class: "kv total" }, h("span", {}, "Total"), h("b", {}, money(o.totalPriceSet.shopMoney.amount, cur))))) : null;

  mount(root,
    h("div", { class: "op-title" },
      h("div", { style: { minWidth: 0 } },
        h("h1", {}, o ? o.name : "New label",
          o?.priority ? h("span", { class: "badge warn plain" }, "Priority") : null,
          o?.international ? h("span", { class: "badge plain" }, `International · ${a.countryCodeV2}`) : null,
          o?.hasLabel ? h("span", { class: "badge good" }, "Label bought") : null),
        h("div", { class: "small muted" }, o ? `${shortDate(o.createdAt)} · ${o.itemCount} item${o.itemCount === 1 ? "" : "s"} · ${money(o.totalPriceSet.shopMoney.amount, cur)}` : "Not linked to an order — for replacements, samples, etc."))),
    h("div", { class: "op-grid" + (aside ? "" : " solo") },
      h("div", { class: "op-main" },
        buyEl,
        notices.length ? h("div", { class: "stack" }, notices) : null,
        shipTo,
        noteCard,
        packages,
        service,
        customsEl),
      aside));

  // The bar at the top: chosen service, cost, margin and the buy button (Ctrl+P)
  function drawBuyBar() {
    if (s.bought) return;
    const fulfill = s.fulfillBox ??= h("input", { type: "checkbox", checked: !!o });
    const notify = s.notifyBox ??= h("input", { type: "checkbox", checked: true });
    const r = s.rate;
    const buy = h("button", { class: "btn primary op-buy-btn", disabled: !r },
      icon("printer"), r ? (split() ? `Buy ${s.parcels.length} labels & print` : "Buy & print label") : "Pick a service", r ? h("kbd", {}, navigator.platform?.startsWith("Mac") ? "⌘P" : "Ctrl+P") : null);
    buy.onclick = busy(buy, () => purchase(fulfill.checked, notify.checked));
    if (page) page.buy = () => (r && !buy.disabled ? buy.click() : toast(ready() ? "Pick a service first" : "Finish the address, box and weight first", true));
    const m = r && paid !== null ? paid - r.total : null;
    mount(buyEl,
      h("div", { class: "op-buy-main" },
        h("div", { class: "op-buy-stat" }, h("div", { class: "lbl" }, "Service"), h("b", {}, r ? r.serviceName : "—"),
          r?.days ? h("div", { class: "small muted" }, `Est. ${r.days} business day${r.days > 1 ? "s" : ""}`) : null),
        h("div", { class: "op-buy-stat" }, h("div", { class: "lbl" }, split() ? `Labels (${s.parcels.length})` : "Label"), h("b", {}, r ? money(r.total, r.currency) : "—"),
          r && split() && r.perBox?.length === s.parcels.length ? h("div", { class: "small muted" }, r.perBox.map((x) => money(x, r.currency)).join(" + ")) : null),
        paid !== null ? h("div", { class: "op-buy-stat" }, h("div", { class: "lbl" }, "Customer paid"), h("b", {}, money(paid, "USD"))) : null,
        m !== null ? h("div", { class: "op-buy-stat" }, h("div", { class: "lbl" }, "Margin"), h("b", { class: "margin " + (m >= 0 ? "pos" : "neg") }, marginText(m))) : null,
        buy),
      h("div", { class: "op-buy-opts" },
        o ? h("label", { class: "check" }, fulfill, "Mark fulfilled in Shopify") : null,
        o ? h("label", { class: "check" }, notify, "Email the customer their tracking") : null,
        h("span", { class: "small muted", style: { marginLeft: "auto" } }, printSettings().labels === "zebra" ? "Prints to your Zebra printer" : "Opens the 4×6 label to print")));
  }

  async function purchase(fulfill, notify) {
    if (!s.rate) return;
    if (isIntl() && customsProblems().length) { toast(customsProblems()[0], true); customsEl.scrollIntoView({ behavior: "smooth" }); return; }
    if (isIntl() && !s.to.phone?.trim()) { toast("Add the customer's phone number — carriers need it for international shipments", true); inputs.phone?.focus(); return; }
    if (s.addr?.status === "invalid" && !confirm("The carrier couldn't find this address. Buy the label anyway?")) return;
    if (s.addr?.status === "corrected" && !confirm("There's a suggested correction for this address you haven't used. Buy with the address as typed?")) return;
    if (split() && lines.some((l) => l.qty !== s.parcels.reduce((n, p) => n + (p.alloc[l.id] || 0), 0))
      && !confirm("Some items aren't assigned to a box. Buy the labels anyway?")) return;
    const win = reserveWindow();
    try {
      const r = await api("/shipping/labels", {
        method: "POST",
        body: {
          orderId: o?.id, ticketId: opts.ticketId ? Number(opts.ticketId) : undefined, to: s.to, parcels: s.parcels.map(cleanParcel),
          presetId: s.parcels.length === 1 && s.parcels[0].preset ? Number(s.parcels[0].preset) : undefined,
          serviceCode: s.rate.serviceCode, serviceName: s.rate.serviceName, listTotal: s.rate.listTotal, perBox: s.rate.perBox,
          labelFormat: labelFormat(), fulfill, notifyCustomer: notify, signature: s.signature || undefined, batchId: newBatchId(),
          customs: isIntl() ? s.customs : undefined,
        },
      });
      await printLabels({ ids: [r.id] }, win).catch((e) => toast(e.message, true));
      clearTimeout(saveTimer);
      if (o) drafts.delete(o.id);
      showPurchased(r);
      if (o) o.hasLabel = true;
      queueApi?.reload();
    } catch (e) {
      win?.close();
      if (/ship-from \(return\) address needs a phone/.test(e.message)) {
        mount(ratesEl, shipFromPhoneFix(e.message, () => { drawRates(); toast("Saved — buy the label again"); }));
        ratesEl.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      throw e;
    }
  }

  function drawRates() {
    drawTotalWeight();
    drawBuyBar();
    drawBoxCosts();
    if (!s.rates.length) {
      return mount(ratesEl, h("div", { class: "op-card-head" }, h("h3", {}, "Service")), ready() ? null : h("div", { class: "notice" },
        s.parcels.some((p) => !(+p.weight > 0)) ? "Enter the weight to see rates and your margin." : isIntl() && !s.customs ? "Fill in customs to see rates." : "Finish the address and box size to see rates."));
    }
    const cheapest = Math.min(...s.rates.map((r) => r.total));
    const timed = s.rates.filter((r) => r.days);
    const fastestDays = timed.length ? Math.min(...timed.map((r) => r.days)) : null;
    const best = paid !== null ? Math.max(...s.rates.map((r) => paid - r.total)) : null;
    mount(ratesEl,
      h("div", { class: "op-card-head" },
        h("h3", {}, "Service", split() ? h("span", { class: "small muted", style: { fontWeight: 500 } }, ` · ${s.parcels.length} boxes, one shipment`) : null),
        h("div", { class: "row", style: { gap: "8px" } },
          paid !== null ? h("span", { class: "small muted" }, `Margin = ${money(paid, "USD")} paid − label`) : null,
          h("button", { class: "btn sm ghost icon-only", title: "Refresh rates", "aria-label": "Refresh rates", onclick: () => quote(0) }, icon("refresh")))),
      h("div", { class: "rates", role: "radiogroup" }, s.rates.map((r) => {
        const margin = paid !== null ? paid - r.total : null;
        return h("div", {
          class: "rate" + (s.rate === r ? " sel" : ""), role: "radio", tabindex: 0, "aria-checked": s.rate === r,
          onclick: () => { s.rate = r; drawRates(); remember(); },
          onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); s.rate = r; drawRates(); remember(); } },
        },
          h("span", { class: "radio" }),
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontWeight: 700 } }, r.serviceName),
            h("div", { class: "row", style: { gap: "6px", marginTop: "2px" } },
              h("span", { class: "small muted" }, r.days ? `Est. ${r.days} business day${r.days > 1 ? "s" : ""}` : "Transit time varies"),
              r.total === cheapest ? h("span", { class: "badge plain" }, "Cheapest") : null,
              fastestDays !== null && r.days === fastestDays ? h("span", { class: "badge plain" }, "Fastest") : null,
              o?.requestedService && sameService(o.requestedService, r.serviceName) ? h("span", { class: "badge plain" }, "Customer's choice") : null,
              plan?.service === r.serviceCode ? h("span", { class: "badge plain" }, "By rule") : null),
            split() && r.perBox?.length === s.parcels.length ? h("div", { class: "small muted per-box" }, r.perBox.map((x, i) => `Box ${i + 1} ${money(x, r.currency)}`).join(" · ")) : null),
          h("div", { class: "price-col" },
            h("div", { class: "price" }, money(r.total, r.currency), r.listTotal > r.total ? h("span", { class: "list" }, money(r.listTotal, r.currency)) : null),
            margin !== null ? h("div", { class: "margin " + (margin >= 0 ? "pos" : "neg"), title: margin === best ? "Best margin" : null }, `${marginText(margin)} margin`) : null));
      })));
  }

  function showPurchased(r) {
    s.bought = true;
    if (page) page.buy = () => printLabels({ ids: [r.id] }).catch((e) => toast(e.message, true));
    const boxes = s.parcels.map(cleanParcel);
    const nextUp = (() => {
      const list = opts.list ?? [];
      const i = o ? list.findIndex((x) => x.id === o.id) : -1;
      return i >= 0 ? list.slice(i + 1).find((x) => !x.hasLabel && !(queueApi?.find(x.id)?.hasLabel)) : null;
    })();
    buyEl.classList.add("done");
    mount(buyEl, h("div", { class: "success-card fade-in" },
      h("h2", {}, split() ? `${s.parcels.length} labels bought` : "Label bought"),
      h("p", { style: { margin: "4px 0 12px", opacity: 0.85 } }, `${s.rate.serviceName} · ${money(r.cost, r.currency)}${o ? ` · ${o.name}` : ""}${paid !== null ? ` · margin ${marginText(paid - r.cost)}` : ""}`),
      r.trackingNumbers.map((n, i) => h("div", { class: "tn" }, split() ? h("span", { class: "small", style: { opacity: 0.8, marginRight: "8px" } }, `Box ${i + 1}`) : null,
        h("a", { href: trackHref(n), target: "_blank", rel: "noopener" }, n),
        r.perBox?.[i] !== undefined ? h("span", { class: "small", style: { opacity: 0.85, marginLeft: "10px", fontFamily: "var(--ui)" } }, money(r.perBox[i], r.currency)) : null)),
      r.fulfillError ? h("div", { class: "notice bad", style: { marginTop: "12px" } }, `The label is fine, but marking the order fulfilled in Shopify failed: ${r.fulfillError}`) : null,
      r.forms ? h("div", { class: "notice", style: { marginTop: "12px" } }, `Customs paperwork: print ${r.forms > 1 ? "these" : "this"} and put 3 copies in a clear pouch on the box (skip if UPS Paperless Invoice is on for your account).`,
        h("div", { class: "row", style: { marginTop: "8px" } }, Array.from({ length: r.forms }, (_, n) => h("a", { class: "btn sm", href: `/api/shipping/labels/${r.id}/forms/${n}`, target: "_blank", rel: "noopener" }, icon("printer"), r.forms > 1 ? `Customs form ${n + 1}` : "Print customs form")))) : null,
      h("div", { class: "row", style: { marginTop: "16px" } },
        nextUp ? h("button", { class: "btn primary", onclick: () => openOrderPage(queueApi?.find(nextUp.id) ?? nextUp, { list: opts.list }) }, "Next order", h("span", { style: { opacity: 0.75 } }, nextUp.name), icon("down")) : null,
        h("button", { class: nextUp ? "btn" : "btn primary", onclick: () => printLabels({ ids: [r.id] }).catch((e) => toast(e.message, true)) }, icon("printer"), split() ? "Print labels again" : "Print again"),
        split() && o ? h("button", { class: "btn", onclick: () => printBoxSlips(o, boxes, r.trackingNumbers) }, "Box contents slips") : null,
        opts.ticketId ? h("a", { class: "btn", href: `/tickets/${opts.ticketId}`, "data-link": "", onclick: () => closeOrderPage(true) }, "Back to ticket") : null,
        h("button", { class: "btn", onclick: () => closeOrderPage() }, "Done"))));
    buyEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  drawParcels();
  drawRates();
  quote(0);
  verifySoon(0);
  if (isIntl()) loadCustoms();
}

const sameService = (chosen, service) => {
  const a = chosen.toLowerCase();
  // A checkout option only means USPS when it says so; generic names ("Standard") mean UPS, your default carrier
  if (/^usps/i.test(service) !== /usps|postal|ground advantage|priority mail/.test(a)) return false;
  if (/^usps/i.test(service)) return a.includes(service.toLowerCase().replace(/^usps\s+/, "").replace(" mail", ""));
  const b = service.toLowerCase().replace(/^ups\s+/, "");
  return a.includes(b) || (b.includes("ground") && /ground|standard/.test(a)) || (b.includes("2nd day") && /2.?day|two.?day|express/.test(a)) || (b.includes("next day") && /next.?day|overnight/.test(a));
};

/** One 4×6 page per box: "Box 2 of 3", what's inside, its tracking number. */
function printBoxSlips(o, boxes, tracking) {
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups to print box slips", true);
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  w.document.write(`<!doctype html><title>${esc(o.name)} boxes</title><style>
@page { size: 4in 6in; margin: 0.25in; } body { font: 12pt/1.35 Arial, sans-serif; margin: 0; }
.page { page-break-after: always; } h1 { font-size: 22pt; margin: 0 0 4pt; } h2 { font-size: 13pt; margin: 0 0 10pt; font-weight: normal; }
li { margin: 3pt 0; } .tn { font-family: monospace; font-size: 11pt; margin-top: 10pt; }</style>
${boxes.map((b, i) => `<div class="page"><h1>Box ${i + 1} of ${boxes.length}</h1><h2>${esc(o.name)} · ${esc(o.shippingAddress?.name ?? "")}</h2>
<ul>${(b.contents ?? []).map((c) => `<li><b>${c.qty} ×</b> ${esc(c.title)}</li>`).join("") || "<li>(no items assigned)</li>"}</ul>
${tracking[i] ? `<div class="tn">${/^1Z/i.test(tracking[i]) ? "UPS" : "USPS"} ${esc(tracking[i])}</div>` : ""}</div>`).join("")}
<script>onload = () => print()</script>`);
  w.document.close();
}

// ---------------------------------------------------------------- Batches

async function renderBatches(root) {
  const importEl = h("div");
  const listEl = h("div");
  mount(root, importEl, listEl);
  renderBatchList(listEl, importEl);
}

const num = (v) => {
  const t = String(v ?? "").replace(/[$,\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Redo export rows (one per box) → orders with their boxes. */
function redoOrders(rows) {
  const by = new Map();
  for (const r of rows) {
    const name = (r["order"] ?? "").trim();
    if (!name) continue;
    if (!by.has(name)) by.set(name, { order: name, customer: r["customer"] ?? "", orderDate: r["order date"] ?? "", boxes: [] });
    by.get(name).boxes.push({
      tracking: (r["tracking number"] ?? "").trim(), status: r["delivery status"] ?? "", shipped: r["shipped date"] ?? "",
      selection: r["shipping selection"] ?? "", rate: num(r["rate"]), paid: num(r["shipping paid by customer"]), margin: num(r["shipping margin"]),
    });
  }
  return [...by.values()];
}

function importCard(el, imported, reload) {
  const go = h("button", { class: "btn" }, icon("download"), "Import Redo shipping export (CSV)");
  go.onclick = async () => {
    const i = h("input", { type: "file", accept: ".csv,text/csv", hidden: true });
    document.body.append(i);
    i.onchange = async () => {
      const file = i.files[0];
      i.remove();
      if (!file) return;
      const rows = parseCsv(await file.text());
      if (!rows.length || !("tracking number" in rows[0]) || !("rate" in rows[0])) return toast("That doesn't look like a Redo shipping export (needs Order, Tracking number and Rate columns)", true);
      const orders = redoOrders(rows);
      const year = new Date().getFullYear();
      const thisYear = orders.filter((o) => o.boxes.some((b) => b.shipped.endsWith(String(year))) || (!o.boxes.some((b) => b.shipped) && o.orderDate.endsWith(String(year))));
      if (!confirm(`${rows.length} rows · ${orders.length} orders (${thisYear.length} from ${year}).\n\nImport the ${year} orders? Each order's boxes are added up and the customer's shipping payment is counted once, checked against Shopify. Re-importing the same file updates them.`)) return;
      await runImport(el, thisYear, reload);
    };
    i.click();
  };
  mount(el, h("section", { class: "card" },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("div", {}, h("h2", {}, "Shipping history from Redo"),
        imported?.orders
          ? h("p", { class: "muted small", style: { margin: 0 } }, `${imported.orders} orders imported (${shortDate(imported.first)} – ${shortDate(imported.last)}) · labels ${money(imported.cost, "USD")} · collected ${money(imported.paid, "USD")} · margin `,
            h("b", { class: imported.paid - imported.cost >= 0 ? "pos" : "neg" }, marginText(imported.paid - imported.cost)),
            h("span", {}, ` (Redo reported ${marginText(imported.reported)})`))
          : h("p", { class: "muted small", style: { margin: 0 } }, "Import past labels so analytics cover the whole year. Split orders are counted correctly: every box's label cost, the customer's shipping once.")),
      go)));
}

async function runImport(el, orders, reload) {
  const bar = h("div", { class: "progress" }, h("i", { style: { width: "0%" } }));
  const status = h("div", { class: "small" });
  mount(el, h("section", { class: "card", role: "status" }, h("div", { class: "row" }, spinner(), h("b", {}, "Importing Redo history…")), bar, status));
  const results = [];
  let skipped = 0;
  let failed = 0;
  const CHUNK = 40;
  for (let i = 0; i < orders.length; i += CHUNK) {
    status.textContent = `${Math.min(i + CHUNK, orders.length)} of ${orders.length} orders`;
    try {
      const r = await api("/shipping/import/redo", { method: "POST", body: { orders: orders.slice(i, i + CHUNK), fresh: i === 0 } });
      results.push(...r.results);
      skipped += r.skipped;
    } catch (e) {
      failed += Math.min(CHUNK, orders.length - i);
      toast(`Batch ${i / CHUNK + 1}: ${e.message}`, true);
    }
    bar.firstChild.style.width = `${Math.round(((i + CHUNK) / orders.length) * 100)}%`;
  }
  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  const counted = results.filter((r) => !r.voided);
  const cost = sum((r) => (r.voided ? 0 : r.cost));
  const paid = sum((r) => (r.voided ? 0 : r.paid));
  const reported = sum((r) => r.reportedMargin);
  const split = results.filter((r) => r.boxes > 1);
  const fromShopify = results.filter((r) => r.paidSource === "shopify").length;
  const noted = results.filter((r) => r.notes.length);
  const download = () => {
    const lines = [["order", "boxes", "label_cost", "customer_paid_shipping", "paid_source", "true_margin", "redo_margin", "difference", "notes"].join(",")];
    for (const r of results) lines.push([r.order, r.boxes, r.cost.toFixed(2), r.paid.toFixed(2), r.paidSource, r.margin.toFixed(2), r.reportedMargin.toFixed(2), (r.reportedMargin - r.margin).toFixed(2), `"${r.notes.join("; ").replace(/"/g, "'")}"`].join(","));
    const a = h("a", { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: "redo-shipping-check.csv" });
    a.click();
  };
  mount(el, h("section", { class: "card fade-in" },
    h("h2", {}, `Imported ${counted.length} orders`),
    h("div", { class: "kpis", style: { margin: "12px 0" } },
      h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Label spend"), h("div", { class: "kpi-value" }, money(cost, "USD")), h("div", { class: "kpi-sub" }, `${sum((r) => r.boxes)} boxes`)),
      h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Shipping collected"), h("div", { class: "kpi-value" }, money(paid, "USD")), h("div", { class: "kpi-sub" }, `${fromShopify} of ${results.length} checked in Shopify`)),
      h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "True margin"), h("div", { class: "kpi-value " + (paid - cost >= 0 ? "pos" : "neg") }, marginText(paid - cost)), h("div", { class: "kpi-sub" }, "payment counted once per order")),
      h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Redo reported"), h("div", { class: "kpi-value" }, marginText(reported)), h("div", { class: "kpi-sub" }, `overstated by ${money(reported - (paid - cost), "USD")}`))),
    split.length ? [h("h3", { class: "section" }, `${split.length} orders shipped in more than one box`),
      h("div", { class: "tbl-wrap", style: { maxHeight: "360px", overflowY: "auto" } }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, ["Order", "Boxes", "Labels", "Customer paid", "True margin", "Redo said"].map((x) => h("th", { class: x === "Order" ? null : "num" }, x)))),
        h("tbody", {}, split.sort((a, b) => (b.reportedMargin - b.margin) - (a.reportedMargin - a.margin)).map((r) => h("tr", { title: r.notes.join("\n") || null },
          h("td", {}, h("b", {}, r.order)), h("td", { class: "num" }, r.boxes), h("td", { class: "num" }, money(r.cost, "USD")), h("td", { class: "num" }, money(r.paid, "USD")),
          h("td", { class: "num margin " + (r.margin >= 0 ? "pos" : "neg") }, marginText(r.margin)), h("td", { class: "num muted" }, marginText(r.reportedMargin)))))))] : null,
    noted.length ? h("details", { style: { marginTop: "12px" } }, h("summary", { class: "small" }, `${noted.length} orders with notes (refunded shipping, cancelled or shared labels)`),
      h("ul", { class: "small" }, noted.slice(0, 200).map((r) => h("li", {}, h("b", {}, r.order), " — ", r.notes.join("; "))))) : null,
    h("p", { class: "small muted" }, `${skipped} orders had no label in Redo and were skipped.`, failed ? ` ${failed} couldn't be imported — run the import again to retry.` : "",
      results.length - fromShopify ? ` ${results.length - fromShopify} orders weren't found in Shopify (manual orders, or older than 60 days if the app lacks the read_all_orders scope) — Redo's payment was used, counted once.` : ""),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: download }, icon("download"), "Download the check (CSV)"), h("button", { class: "btn ghost", onclick: reload }, "Done"))));
}

async function renderBatchList(root, importEl) {
  mount(root, h("div", { class: "card" }, skeletonRows(4)));
  let batches, imported;
  try {
    ({ batches, imported } = await api("/shipping/batches"));
  } catch (e) {
    return mount(root, h("div", { class: "notice bad" }, e.message));
  }
  importCard(importEl, imported, () => renderBatchList(root, importEl));
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
          if (!confirm(l.carrier === "USPS" ? "Void this USPS label? EasyPost refunds the postage to your wallet (USPS takes up to a few weeks)." : "Void this label with UPS? You won't be charged for it.")) return;
          await api(`/shipping/labels/${l.id}/void`, { method: "POST" });
          toast("Label voided");
          renderBatchList(root, importEl);
        });
        return h("tr", {},
          h("td", {}, l.order_name || "—"),
          h("td", {}, l.ship_to?.name, h("div", { class: "small muted" }, [l.ship_to?.city, l.ship_to?.state].filter(Boolean).join(", "))),
          h("td", {}, l.service_name, l.status === "voided" ? h("span", { class: "badge bad", style: { marginLeft: "6px" } }, "Voided") : null),
          h("td", { class: "mono" }, l.tracking_numbers.map((n) => h("div", {}, h("a", { href: trackHref(n), target: "_blank", rel: "noopener" }, n)))),
          h("td", { class: "num" }, l.cost != null ? money(l.cost, l.currency) : ""),
          h("td", { style: { whiteSpace: "nowrap" } }, l.status !== "voided" ? h("button", { class: "btn sm", onclick: () => printLabels({ ids: [l.id] }).catch((e) => toast(e.message, true)) }, "Print") : null,
            l.forms ? Array.from({ length: l.forms }, (_, n) => h("a", { class: "btn sm ghost", href: `/api/shipping/labels/${l.id}/forms/${n}`, target: "_blank", rel: "noopener" }, l.forms > 1 ? `Customs ${n + 1}` : "Customs")) : null,
            l.status !== "voided" ? voidBtn : null));
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
