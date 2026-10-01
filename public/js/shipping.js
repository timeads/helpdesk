import { api } from "./api.js";
import { h, mount, icon, money, shortDate, relTime, toast, busy, spinner, skeletonRows } from "./ui.js";

const EMPTY_TO = { name: "", company: "", phone: "", address1: "", address2: "", city: "", state: "", zip: "", country: "US", residential: true };

export function renderShipping(main) {
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab") || "create";
  const tabs = h("nav", { class: "tabs-line", "aria-label": "Shipping" },
    h("a", { class: "tab" + (tab === "create" ? " active" : ""), href: "/shipping", "data-link": "" }, "Create label"),
    h("a", { class: "tab" + (tab === "history" ? " active" : ""), href: "/shipping?tab=history", "data-link": "" }, "Label history"));
  const body = h("div");
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("h1", {}, "Shipping"),
      h("p", { class: "sub" }, "Buy UPS labels for Shopify orders, print them 4×6, and mark the order fulfilled."),
      tabs)),
    h("div", { class: "page-inner" }, body)));

  api("/shipping/status").then((status) => {
    if (!status.ups) {
      body.prepend(h("div", { class: "notice info", style: { marginBottom: "16px" } }, "UPS isn't connected yet. Add your UPS API keys (see the README) to get rates and buy labels."));
    } else if (status.upsEnv !== "production") {
      body.prepend(h("div", { class: "notice info", style: { marginBottom: "16px" } }, "Test mode: labels come from the UPS test environment and aren't billed. Set UPS_ENV to \"production\" when you're ready."));
    }
  }).catch(() => {});

  if (tab === "history") renderHistory(body);
  else renderCreate(body, params.get("order"), params.get("ticket"));
  return () => {};
}

// ---------------------------------------------------------------- Create

function renderCreate(root, preselect, ticketId) {
  const s = { order: null, to: { ...EMPTY_TO }, parcels: [], rates: [], rate: null, presets: [] };
  const search = h("input", { class: "input", type: "search", placeholder: "Order #, email or name", "aria-label": "Search orders" });
  const ordersEl = h("div", { class: "ship-orders" }, skeletonRows(5));
  const builder = h("div");
  mount(root, h("div", { class: "ship-layout" },
    h("div", { class: "card ship-list" },
      h("div", { class: "head" }, h("h2", {}, "Ready to ship"), h("div", { class: "search" }, icon("search"), search)),
      ordersEl),
    builder));

  let orders = [];
  const loadOrders = async () => {
    try {
      ({ orders } = await api(`/shipping/orders?q=${encodeURIComponent(search.value.trim())}`));
      drawOrders();
    } catch (e) {
      mount(ordersEl, h("div", { class: "empty" }, e.message));
    }
  };
  const drawOrders = () => mount(ordersEl, orders.length
    ? orders.map((o) => h("div", { class: "o-row" + (s.order?.id === o.id ? " active" : ""), onclick: () => pick(o) },
        h("div", { class: "row", style: { justifyContent: "space-between" } }, h("b", {}, o.name), h("span", { class: "small muted" }, relTime(o.createdAt))),
        h("div", { class: "small" }, o.shippingAddress?.name || o.email || "—", o.shippingAddress ? h("span", { class: "muted" }, ` · ${o.shippingAddress.city}, ${o.shippingAddress.provinceCode}`) : null),
        h("div", { class: "row", style: { gap: "4px" } },
          h("span", { class: "small muted" }, `${o.lineItems.nodes.reduce((n, l) => n + l.quantity, 0)} items`),
          o.shippingLines.nodes[0] ? h("span", { class: "small muted" }, `· ${o.shippingLines.nodes[0].title}`) : null,
          o.hasLabel ? h("span", { class: "badge good" }, "Label bought") : null)))
    : h("div", { class: "empty" }, h("h2", {}, search.value ? "No matching orders" : "Everything's shipped"), h("p", {}, search.value ? "Try an order number like 1042, or the customer's email." : "Unfulfilled Shopify orders appear here. Use Blank label for replacements.")));
  let t;
  search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(loadOrders, 300); });

  const pick = (o) => {
    s.order = o;
    const a = o.shippingAddress || {};
    s.to = {
      name: a.name || "", company: a.company || "", phone: a.phone || o.phone || "", email: o.email || "",
      address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", state: a.provinceCode || "",
      zip: a.zip || "", country: a.countryCodeV2 || "US", residential: !a.company,
    };
    // Estimate weight from Shopify product weights
    const lbs = o.lineItems.nodes.reduce((sum, l) => {
      const w = l.variant?.inventoryItem?.measurement?.weight;
      if (!w) return sum;
      const factor = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.20462, GRAMS: 0.00220462 }[w.unit] ?? 1;
      return sum + w.value * factor * l.quantity;
    }, 0);
    const box = s.presets[0];
    s.parcels = [{ preset: box?.id ?? "", length: box?.length ?? "", width: box?.width ?? "", height: box?.height ?? "", weight: lbs ? Math.round((lbs + (box?.weight ?? 0)) * 10) / 10 : "" }];
    s.rates = [];
    s.rate = null;
    drawOrders();
    drawBuilder();
  };

  const newBlank = () => {
    s.order = null;
    s.to = { ...EMPTY_TO };
    const box = s.presets[0];
    s.parcels = [{ preset: box?.id ?? "", length: box?.length ?? "", width: box?.width ?? "", height: box?.height ?? "", weight: "" }];
    s.rates = [];
    s.rate = null;
    drawOrders();
    drawBuilder();
  };

  function field(label, key, attrs = {}) {
    const input = h("input", { class: "input", value: s.to[key] ?? "", ...attrs });
    input.addEventListener("input", () => { s.to[key] = input.value; s.rates = []; s.rate = null; drawRates(); });
    return h("label", { class: "field" }, label, input);
  }

  const ratesEl = h("div");
  function drawBuilder() {
    const o = s.order;
    const residential = h("input", { type: "checkbox", checked: s.to.residential });
    residential.onchange = () => { s.to.residential = residential.checked; s.rates = []; drawRates(); };
    const parcelsEl = h("div", { class: "stack" });
    const drawParcels = () => mount(parcelsEl, s.parcels.map((p, i) => {
      const presetSel = h("select", { class: "input" },
        h("option", { value: "" }, "Custom size"),
        s.presets.map((b) => h("option", { value: b.id, selected: String(b.id) === String(p.preset) }, b.name)));
      presetSel.onchange = () => {
        const b = s.presets.find((x) => String(x.id) === presetSel.value);
        p.preset = presetSel.value;
        if (b) Object.assign(p, { length: b.length, width: b.width, height: b.height });
        s.rates = [];
        drawParcels();
        drawRates();
      };
      const num = (key, label) => {
        const inp = h("input", { class: "input", type: "number", min: "0", step: key === "weight" ? "0.1" : "0.5", value: p[key], inputmode: "decimal" });
        inp.oninput = () => { p[key] = inp.value; if (key !== "weight") p.preset = ""; s.rates = []; drawRates(); };
        return h("label", { class: "field" }, label, inp);
      };
      return h("div", { class: "parcel" },
        h("label", { class: "field" }, `Package ${i + 1}`, presetSel),
        num("length", "L (in)"), num("width", "W (in)"), num("height", "H (in)"), num("weight", "Weight (lb)"),
        s.parcels.length > 1 ? h("button", { class: "btn ghost sm icon-only", "aria-label": "Remove package", onclick: () => { s.parcels.splice(i, 1); drawParcels(); } }, icon("x")) : h("span"));
    }));
    drawParcels();

    const getRates = h("button", { class: "btn primary get-rates" }, "Get UPS rates");
    getRates.onclick = busy(getRates, async () => {
      mount(ratesEl, h("div", { class: "card" }, skeletonRows(3)));
      try {
        const { rates } = await api("/shipping/rates", { method: "POST", body: { to: s.to, parcels: s.parcels } });
        s.rates = rates;
        s.rate = rates[0] ?? null;
        getRates.className = "btn get-rates";
        getRates.textContent = "Refresh rates";
      } catch (e) {
        s.rates = [];
        mount(ratesEl, h("div", { class: "notice bad" }, e.message));
        return;
      }
      drawRates();
    });

    mount(builder,
      h("div", { class: "card" },
        h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "12px" } },
          h("div", {},
            h("h2", {}, o ? `Order ${o.name}` : "New label"),
            o ? h("div", { class: "small muted" }, `${shortDate(o.createdAt)} · ${money(o.totalPriceSet.shopMoney.amount, o.totalPriceSet.shopMoney.currencyCode)}`,
              o.shippingLines.nodes[0] ? ` · customer chose ${o.shippingLines.nodes[0].title}` : "") : h("div", { class: "small muted" }, "Not linked to an order — for replacements, samples, etc.")),
          h("div", { class: "row" },
            o ? h("a", { class: "btn sm ghost", href: o.adminUrl, target: "_blank", rel: "noopener" }, "Shopify", icon("ext")) : null,
            h("button", { class: "btn sm", onclick: newBlank }, icon("plus"), "Blank label"))),
        o ? h("div", { class: "stack", style: { marginBottom: "14px" } }, o.lineItems.nodes.map((l) =>
          h("div", { class: "line" },
            l.image ? h("img", { src: l.image.url, alt: "" }) : h("div", { class: "ph" }),
            h("div", {}, l.title, l.variantTitle ? h("span", { class: "muted" }, ` · ${l.variantTitle}`) : null),
            h("span", { class: "qty" }, `× ${l.quantity}`)))) : null,
        h("h3", { class: "section" }, "Ship to"),
        h("div", { class: "stack" },
          h("div", { class: "grid2" }, field("Name", "name"), field("Company", "company")),
          h("div", { class: "grid2" }, field("Address", "address1"), field("Apt / suite", "address2")),
          h("div", { class: "grid4" }, field("City", "city"), field("State", "state", { maxlength: 2 }), field("ZIP", "zip"), field("Country", "country", { maxlength: 2 })),
          h("div", { class: "grid2" }, field("Phone", "phone"), h("label", { class: "check", style: { alignSelf: "end", paddingBottom: "8px" } }, residential, "Residential address"))),
        h("h3", { class: "section" }, "Packages"),
        parcelsEl,
        h("div", { class: "row", style: { marginTop: "10px" } },
          h("button", { class: "btn sm ghost", onclick: () => { const last = s.parcels.at(-1) ?? {}; s.parcels.push({ ...last, weight: "" }); drawParcels(); } }, icon("plus"), "Add package"),
          h("div", { style: { flex: 1 } }),
          getRates)),
      ratesEl);
    drawRates();
  }

  function drawRates() {
    if (!s.rates.length) return mount(ratesEl);
    const fmt = h("select", { class: "input", style: { width: "auto" } },
      h("option", { value: "GIF" }, "4×6 label (print from browser)"),
      h("option", { value: "ZPL" }, "ZPL (thermal printer)"));
    const fulfill = h("input", { type: "checkbox", checked: !!s.order });
    const notify = h("input", { type: "checkbox", checked: true });
    const buy = h("button", { class: "btn primary", style: { height: "40px", padding: "0 18px" } });
    const label = () => buy.replaceChildren(icon("printer"), s.rate ? `Buy label · ${money(s.rate.total, s.rate.currency)}` : "Pick a service");
    label();
    buy.onclick = busy(buy, async () => {
      if (!s.rate) return;
      const r = await api("/shipping/labels", {
        method: "POST",
        body: {
          orderId: s.order?.id, orderName: s.order?.name, ticketId: ticketId ? Number(ticketId) : undefined,
          to: s.to, parcels: s.parcels, serviceCode: s.rate.serviceCode, serviceName: s.rate.serviceName,
          labelFormat: fmt.value, fulfill: fulfill.checked, notifyCustomer: notify.checked,
        },
      });
      showPurchased(r);
    });
    mount(ratesEl, h("div", { class: "card" },
      h("h2", { style: { marginBottom: "10px" } }, "Choose a service"),
      h("div", { class: "rates" }, s.rates.map((r) => h("div", {
        class: "rate" + (s.rate === r ? " sel" : ""), role: "radio", tabindex: 0, "aria-checked": s.rate === r,
        onclick: () => { s.rate = r; drawRates(); },
      },
        h("span", { class: "radio" }),
        h("div", {}, h("div", { style: { fontWeight: 700 } }, r.serviceName), h("div", { class: "small muted" }, r.days ? `${r.days} business day${r.days > 1 ? "s" : ""}` : "Transit time varies")),
        h("div", { class: "price" }, money(r.total, r.currency), r.listTotal > r.total ? h("span", { class: "list" }, money(r.listTotal, r.currency)) : null)))),
      h("div", { class: "stack", style: { marginTop: "14px" } },
        h("div", { class: "row" }, h("span", { class: "small muted" }, "Label format"), fmt),
        s.order ? h("label", { class: "check" }, fulfill, "Mark the order fulfilled in Shopify with this tracking number") : null,
        s.order ? h("label", { class: "check" }, notify, "Email the customer their shipping confirmation (Shopify)") : null,
        h("div", { class: "buy-bar" }, h("span", { class: "small muted" }, "Charged to your UPS account"), buy))));
  }

  function showPurchased(r) {
    const printUrl = `/api/shipping/labels/${r.id}/print`;
    window.open(printUrl, "_blank");
    mount(ratesEl, h("div", { class: "card success-card fade-in" },
      h("h2", {}, "Label bought"),
      h("p", { style: { margin: "4px 0 12px", opacity: 0.85 } }, `${s.rate.serviceName} · ${money(r.cost, r.currency)}${s.order ? ` · ${s.order.name}` : ""}`),
      r.trackingNumbers.map((n) => h("div", { class: "tn" }, h("a", { href: `https://www.ups.com/track?tracknum=${n}`, target: "_blank", rel: "noopener" }, n))),
      r.fulfillError ? h("div", { class: "notice bad", style: { marginTop: "12px" } }, `The label is fine, but marking the order fulfilled in Shopify failed: ${r.fulfillError}`) : null,
      h("div", { class: "row", style: { marginTop: "16px" } },
        h("a", { class: "btn primary", href: printUrl, target: "_blank" }, icon("printer"), "Print label"),
        ticketId ? h("a", { class: "btn", href: `/tickets/${ticketId}`, "data-link": "" }, "Back to ticket") : null,
        h("button", { class: "btn", onclick: () => { loadOrders(); newBlank(); } }, "Next order"))));
    loadOrders();
  }

  (async () => {
    try {
      s.presets = (await api("/shipping/presets")).presets;
    } catch { /* fine */ }
    await loadOrders();
    if (preselect) {
      const found = orders.find((o) => o.id === preselect);
      if (found) pick(found);
      else {
        try {
          const { order } = await api(`/shipping/orders/${encodeURIComponent(preselect)}`);
          pick(order);
        } catch (e) { toast(e.message, true); newBlank(); }
      }
    } else newBlank();
  })();
}

// ---------------------------------------------------------------- History

async function renderHistory(root) {
  mount(root, h("div", { class: "card" }, skeletonRows(4)));
  let labels;
  try {
    ({ labels } = await api("/shipping/labels"));
  } catch (e) {
    return mount(root, h("div", { class: "notice bad" }, e.message));
  }
  if (!labels.length) return mount(root, h("div", { class: "card empty" }, h("h2", {}, "No labels yet"), h("p", {}, "Every label you buy appears here for reprinting or voiding.")));
  mount(root, h("div", { class: "card tbl-wrap", style: { padding: "6px 12px" } }, h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, ["Date", "Order", "Ship to", "Service", "Tracking", "Cost", "", ""].map((x) => h("th", {}, x)))),
    h("tbody", {}, labels.map((l) => {
      const voidBtn = h("button", { class: "btn sm ghost danger" }, "Void");
      voidBtn.onclick = busy(voidBtn, async () => {
        if (!confirm("Void this label with UPS? You won't be charged for it.")) return;
        await api(`/shipping/labels/${l.id}/void`, { method: "POST" });
        toast("Label voided");
        renderHistory(root);
      });
      return h("tr", {},
        h("td", {}, shortDate(l.created_at)),
        h("td", {}, l.order_name || h("span", { class: "muted" }, "—")),
        h("td", {}, l.ship_to?.name, h("div", { class: "small muted" }, [l.ship_to?.city, l.ship_to?.state].filter(Boolean).join(", "))),
        h("td", {}, l.service_name, l.status === "voided" ? h("span", { class: "badge bad", style: { marginLeft: "6px" } }, "Voided") : null,
          l.fulfilled ? h("span", { class: "badge good", style: { marginLeft: "6px" } }, "Fulfilled") : null),
        h("td", { class: "mono" }, l.tracking_numbers.map((n) => h("div", {}, h("a", { href: `https://www.ups.com/track?tracknum=${n}`, target: "_blank", rel: "noopener" }, n)))),
        h("td", {}, l.cost != null ? money(l.cost, l.currency) : ""),
        h("td", {}, l.status !== "voided" ? h("a", { class: "btn sm", href: `/api/shipping/labels/${l.id}/print`, target: "_blank" }, l.label_format === "ZPL" ? "Download ZPL" : "Print") : null),
        h("td", {}, l.status !== "voided" ? voidBtn : null));
    })))));
}
