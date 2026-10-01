// Shipping & support analytics. Chart palette validated with the dataviz checks (light + dark, CVD-safe).
import { api } from "./api.js";
import { h, mount, money, toast, skeletonRows } from "./ui.js";

const PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"]];
const SVG = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  kids.flat().forEach((k) => k != null && el.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return el;
};
const usd = (n) => money(n ?? 0, "USD");
const usd0 = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n ?? 0);

function delta(cur, prev, { invert = false, fmt = (x) => x } = {}) {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0 || cur === null || cur === undefined) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const good = invert ? pct <= 0 : pct >= 0;
  return h("span", { class: "delta " + (Math.abs(pct) < 0.5 ? "" : good ? "up" : "down"), title: `Previous period: ${fmt(prev)}` }, `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}% vs prior`);
}

function tile(label, value, sub, extra) {
  return h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, label), h("div", { class: "kpi-value" }, value), h("div", { class: "kpi-sub" }, sub, extra ? " " : null, extra));
}

const hours = (h_) => (h_ === null || h_ === undefined ? "—" : h_ < 48 ? `${h_.toFixed(1)} h` : `${(h_ / 24).toFixed(1)} days`);

/** Grouped columns: shipping collected vs label spend per week, with hover tooltip and a table toggle. */
function weeklyChart(rows) {
  const W = 720, H = 240, P = { l: 52, r: 12, t: 12, b: 28 };
  const max = Math.max(1, ...rows.flatMap((r) => [r.collected, r.spend]));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const band = (W - P.l - P.r) / Math.max(1, rows.length);
  const bw = Math.min(24, (band - 10) / 2);
  const tip = h("div", { class: "chart-tip", hidden: true });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Weekly shipping collected vs label spend" });
  for (let v = 0; v <= top + 0.001; v += step) {
    svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: P.l - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" }, usd0(v)));
  }
  rows.forEach((r, i) => {
    const x0 = P.l + band * i + band / 2 - bw - 1;
    const col = (x, v, cls) => {
      const hgt = Math.max(0, y(0) - y(v));
      const rad = Math.min(4, hgt / 2, bw / 2);
      // rounded data-end, square at the baseline
      return s("path", { class: cls, d: `M${x},${y(0)} V${y(v) + rad} Q${x},${y(v)} ${x + rad},${y(v)} H${x + bw - rad} Q${x + bw},${y(v)} ${x + bw},${y(v) + rad} V${y(0)} Z` });
    };
    svg.append(col(x0, r.collected, "s1"), col(x0 + bw + 2, r.spend, "s2"));
    const label = new Date(r.week + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (rows.length <= 14 || i % Math.ceil(rows.length / 12) === 0) svg.append(s("text", { x: P.l + band * i + band / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, label));
    const hit = s("rect", { x: P.l + band * i, y: P.t, width: band, height: H - P.t - P.b, class: "hit", tabindex: 0 });
    const show = (e) => {
      tip.hidden = false;
      mount(tip, h("b", {}, `Week of ${label}`),
        h("div", {}, h("i", { class: "sw s1" }), `Collected ${usd(r.collected)}`),
        h("div", {}, h("i", { class: "sw s2" }), `Label spend ${usd(r.spend)}`),
        h("div", {}, `Margin ${r.margin >= 0 ? "+" : "−"}${usd(Math.abs(r.margin))} · ${r.labels} label${r.labels === 1 ? "" : "s"}`));
      const box = svg.getBoundingClientRect();
      const cx = ((P.l + band * i + band / 2) / W) * box.width;
      tip.style.left = `${Math.min(box.width - 190, Math.max(0, cx - 95))}px`;
      tip.style.top = `0px`;
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("mouseleave", () => (tip.hidden = true));
    hit.addEventListener("blur", () => (tip.hidden = true));
    svg.append(hit);
  });
  svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(0), y2: y(0), class: "base" }));
  const table = h("table", { class: "tbl", hidden: true },
    h("thead", {}, h("tr", {}, ["Week of", "Labels", "Collected", "Label spend", "Margin"].map((x) => h("th", {}, x)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, r.week), h("td", {}, r.labels), h("td", { class: "num" }, usd(r.collected)), h("td", { class: "num" }, usd(r.spend)), h("td", { class: "num" }, usd(r.margin))))));
  const toggle = h("button", { class: "btn sm ghost" }, "Show table");
  toggle.onclick = () => { table.hidden = !table.hidden; chart.hidden = !table.hidden; toggle.textContent = table.hidden ? "Show table" : "Show chart"; };
  const chart = h("div", { class: "chart-wrap" }, svg, tip);
  return h("section", { class: "card" },
    h("div", { class: "row", style: { justifyContent: "space-between" } },
      h("h2", {}, "Shipping collected vs label spend"),
      h("div", { class: "row" }, h("span", { class: "legend" }, h("i", { class: "sw s1" }), "Collected from customers"), h("span", { class: "legend" }, h("i", { class: "sw s2" }), "Spent on labels"), toggle)),
    rows.length ? chart : h("p", { class: "muted" }, "No labels in this period."), table);
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw) ?? raw;
}

/** Horizontal bars: label count by service, value at the bar tip, margin in the next column. */
function servicesCard(rows) {
  const max = Math.max(1, ...rows.map((r) => r.labels));
  return h("section", { class: "card" }, h("h2", {}, "By service"),
    rows.length ? h("div", { class: "hbars" }, rows.map((r) => h("div", { class: "hbar-row", title: `${r.service_name}: ${r.labels} labels, avg ${usd(r.avg_cost)}` },
      h("div", { class: "hbar-label" }, r.service_name),
      h("div", { class: "hbar-track" }, h("i", { style: { width: `${(r.labels / max) * 100}%` } }), h("span", {}, r.labels)),
      h("div", { class: "num small" }, `avg ${usd(r.avg_cost)}`),
      h("div", { class: "num small margin " + (r.margin >= 0 ? "pos" : "neg") }, `${r.margin >= 0 ? "+" : "−"}${usd(Math.abs(r.margin))}`)))) : h("p", { class: "muted" }, "No labels in this period."));
}

export function renderAnalytics(main) {
  const params = new URLSearchParams(location.search);
  let days = Number(params.get("days")) || 30;
  const body = h("div", { class: "stack", style: { gap: "16px" } }, h("div", { class: "card" }, skeletonRows(4)));
  const chips = h("div", { class: "view-chips" });
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between", paddingBottom: "16px" } },
        h("div", {}, h("h1", {}, "Analytics"), h("p", { class: "sub", style: { margin: 0 } }, "What shipping costs you versus what customers pay, how fast orders go out, and support volume.")),
        chips))),
    h("div", { class: "page-inner wide" }, body)));

  const load = async () => {
    mount(chips, PERIODS.map(([d, label]) => h("button", { class: "view-chip" + (d === days ? " active" : ""), onclick: () => { days = d; history.replaceState(null, "", `/analytics?days=${d}`); load(); } }, label)));
    let a;
    try {
      a = await api(`/analytics?days=${days}`);
    } catch (e) {
      return mount(body, h("div", { class: "notice bad" }, e.message));
    }
    const c = a.shipping.current;
    const p = a.shipping.previous;
    const sp = a.support;
    mount(body,
      h("div", { class: "kpis" },
        tile("Shipping margin", h("span", { class: c.margin >= 0 ? "pos" : "neg" }, `${c.margin >= 0 ? "+" : "−"}${usd(Math.abs(c.margin))}`), "collected − label spend", delta(c.margin, p.margin, { fmt: usd })),
        tile("Label spend", usd(c.spend), `${c.labels} label${c.labels === 1 ? "" : "s"}`, delta(c.spend, p.spend, { invert: true, fmt: usd })),
        tile("Shipping collected", usd(c.collected), "paid by customers at checkout", delta(c.collected, p.collected, { fmt: usd })),
        tile("Avg label cost", c.avg_cost ? usd(c.avg_cost) : "—", "per label", delta(c.avg_cost, p.avg_cost, { invert: true, fmt: usd })),
        tile("Order to ship", hours(c.hours_to_ship), "average time from order to label", delta(c.hours_to_ship, p.hours_to_ship, { invert: true, fmt: hours })),
        tile("Negotiated savings", usd(c.saved), "vs UPS published rates"),
        tile("Labels over paid", String(c.losers ?? 0), "orders where the label cost more than the customer paid"),
        tile("Scan-verified", c.labels ? `${Math.round(((c.verified ?? 0) / c.labels) * 100)}%` : "—", "packed at the scan station")),
      weeklyChart(a.weekly),
      h("div", { class: "grid2 analytics-2" },
        servicesCard(a.services),
        h("section", { class: "card" }, h("h2", {}, "Top destinations"),
          a.states.length ? h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["State", "Labels", "Avg cost"].map((x) => h("th", {}, x)))),
            h("tbody", {}, a.states.map((r) => h("tr", {}, h("td", {}, r.state), h("td", {}, r.labels), h("td", { class: "num" }, usd(r.avg_cost)))))) : h("p", { class: "muted" }, "No labels in this period."))),
      h("section", { class: "card" }, h("h2", {}, "Recent labels"),
        a.recent.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Order", "Customer chose", "Shipped with", "Paid", "Label", "Margin"].map((x) => h("th", {}, x)))),
          h("tbody", {}, a.recent.map((r) => {
            const m = r.shipping_paid == null ? null : r.shipping_paid - r.cost;
            return h("tr", {}, h("td", {}, r.order_name || "—"), h("td", {}, r.requested_service || "—"), h("td", {}, r.service_name),
              h("td", { class: "num" }, r.shipping_paid == null ? "—" : usd(r.shipping_paid)), h("td", { class: "num" }, usd(r.cost)),
              h("td", { class: "num margin " + (m === null ? "" : m >= 0 ? "pos" : "neg") }, m === null ? "—" : `${m >= 0 ? "+" : "−"}${usd(Math.abs(m))}`));
          })))) : h("p", { class: "muted" }, "No labels in this period.")),
      h("h2", { class: "analytics-h" }, "Support"),
      h("div", { class: "kpis" },
        tile("New tickets", String(sp.created), `in the last ${days} days`),
        tile("Closed", String(sp.closed), "tickets closed"),
        tile("Open now", String(sp.open), `${sp.pending} waiting on customers`),
        tile("First reply", hours(sp.medianFirstReplyHours), `median, ${sp.replied} replied`)),
    );
  };
  load().catch((e) => toast(e.message, true));
  return () => {};
}
