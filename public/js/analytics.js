// Dashboard: shipping & support analytics. Chart palette validated with the dataviz checks (light + dark, CVD-safe).
import { api } from "./api.js";
import { h, mount, money, toast, skeletonRows } from "./ui.js";
import { rateCheckCard } from "./ratecheck.js";

const PERIODS = [[7, "7 days"], [30, "30 days"], [90, "90 days"], ["ytd", "Year to date"], [365, "12 months"]];
const SVG = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  kids.flat().forEach((k) => k != null && el.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return el;
};
const usd = (n) => money(n ?? 0, "USD");
const usd0 = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n ?? 0);

let compareLabel = "vs prior";
function delta(cur, prev, { invert = false, fmt = (x) => x } = {}) {
  if (prev === null || prev === undefined || !Number.isFinite(prev) || prev === 0 || cur === null || cur === undefined) return null;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const good = invert ? pct <= 0 : pct >= 0;
  return h("span", { class: "delta " + (Math.abs(pct) < 0.5 ? "" : good ? "up" : "down"), title: `Previous period: ${fmt(prev)}` }, `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}% ${compareLabel}`);
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

/** AI usage: what the AI features cost (priced from each response's token counts). */
function aiUsageCard(u) {
  const cents = (n) => (n > 0 && n < 0.995 ? `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}¢` : usd(n));
  const W = 720, H = 200, P = { l: 52, r: 12, t: 12, b: 28 };
  const max = Math.max(0.01, ...u.days.map((d) => d.cost));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const band = (W - P.l - P.r) / u.days.length;
  const bw = Math.min(16, band - 4);
  const tip = h("div", { class: "chart-tip", hidden: true });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "AI cost per day, last 30 days" });
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: P.l - 8, y: y(v) + 4, class: "axis", "text-anchor": "end" }, cents(v)));
  }
  u.days.forEach((d, i) => {
    const x = P.l + band * i + (band - bw) / 2;
    const hgt = Math.max(0, y(0) - y(d.cost));
    const rad = Math.min(4, hgt / 2, bw / 2);
    if (hgt > 0) svg.append(s("path", { class: "s1", d: `M${x},${y(0)} V${y(d.cost) + rad} Q${x},${y(d.cost)} ${x + rad},${y(d.cost)} H${x + bw - rad} Q${x + bw},${y(d.cost)} ${x + bw},${y(d.cost) + rad} V${y(0)} Z` }));
    const label = new Date(d.day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (i % 5 === 0 || i === u.days.length - 1) svg.append(s("text", { x: P.l + band * i + band / 2, y: H - 8, class: "axis", "text-anchor": "middle" }, label));
    const hit = s("rect", { x: P.l + band * i, y: P.t, width: band, height: H - P.t - P.b, class: "hit", tabindex: 0 });
    const show = () => {
      tip.hidden = false;
      mount(tip, h("b", {}, label), h("div", {}, h("i", { class: "sw s1" }), `AI cost ${cents(d.cost)}`));
      const box = svg.getBoundingClientRect();
      const cx = ((P.l + band * i + band / 2) / W) * box.width;
      tip.style.left = `${Math.min(box.width - 190, Math.max(0, cx - 95))}px`;
      tip.style.top = "0px";
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("mouseleave", () => (tip.hidden = true));
    hit.addEventListener("blur", () => (tip.hidden = true));
    svg.append(hit);
  });
  svg.append(s("line", { x1: P.l, x2: W - P.r, y1: y(0), y2: y(0), class: "base" }));
  const chart = h("div", { class: "chart-wrap" }, svg, tip);
  const table = h("table", { class: "tbl", hidden: true },
    h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "AI cost"))),
    h("tbody", {}, u.days.map((d) => h("tr", {}, h("td", {}, d.day), h("td", { class: "num" }, cents(d.cost))))));
  const toggle = h("button", { class: "btn sm ghost" }, "Show table");
  toggle.onclick = () => { table.hidden = !table.hidden; chart.hidden = !table.hidden; toggle.textContent = table.hidden ? "Show table" : "Show chart"; };
  const fmax = Math.max(1e-9, ...u.features.map((f) => f.cost));
  const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  return [
    h("div", { class: "kpis ai-kpis" },
      tile("AI today", cents(u.today), "so far today (UTC)"),
      tile("AI this month", cents(u.month), u.backlog?.month > 0.005 ? `incl. ${cents(u.backlog.month)} one-time backlog` : `${u.monthCalls.toLocaleString()} calls · ${tokens(u.monthTokens)} tokens`),
      tile("Projected this month", cents(u.projected), "spent so far + everyday use for the days left"),
      u.everyday ? tile("Typical month", u.everyday.typical.high - u.everyday.typical.low > Math.max(0.5, u.everyday.typical.low * 0.05) ? `${cents(u.everyday.typical.low)}–${cents(u.everyday.typical.high)}` : `≈ ${cents((u.everyday.typical.low + u.everyday.typical.high) / 2)}`,
        `everyday use ${cents(u.everyday.daily)}/day (last ${u.everyday.basisDays} day${u.everyday.basisDays === 1 ? "" : "s"}) + ${u.everyday.perMonthRepairs.low}–${u.everyday.perMonthRepairs.high} new repair emails`) : null,
      tile("Last month", cents(u.prevMonth), "for comparison")),
    u.backlog?.cost > 0 ? h("section", { class: "card backlog-card" },
      h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "baseline" } },
        h("h2", {}, "One-time: reading old support email"), h("span", { class: "badge plain" }, "not in the monthly estimate")),
      h("div", { class: "kpis compact" },
        tile("Spent", cents(u.backlog.cost), `${u.backlog.calls.toLocaleString()} calls${u.backlog.first ? ` · ${u.backlog.first.slice(5)} to ${u.backlog.last.slice(5)}` : ""}`),
        tile("Conversations read", u.backlog.conversations.toLocaleString(), "into the repair manual"),
        tile("Per conversation", u.backlog.perConversation === null ? "—" : cents(u.backlog.perConversation), "average"),
        u.everyday?.repairs ? tile("New repairs a month", `${cents(u.everyday.repairs.low)}–${cents(u.everyday.repairs.high)}`, `${u.everyday.perMonthRepairs.low}–${u.everyday.perMonthRepairs.high} emails at that rate (in Typical month)`) : null),
      h("p", { class: "small muted", style: { margin: "8px 0 0" } }, "The backlog of past email is a one-time cost. New repair conversations read from now on count as everyday use.")) : null,
    h("div", { class: "grid2 analytics-2" },
      h("section", { class: "card" },
        h("div", { class: "row", style: { justifyContent: "space-between" } }, h("h2", {}, "AI cost per day"), toggle),
        u.days.some((d) => d.cost > 0) ? chart : h("p", { class: "muted" }, "No AI use recorded yet — it starts counting from this update."), table),
      h("section", { class: "card" }, h("h2", {}, "This month by feature"),
        u.features.length ? h("div", { class: "hbars" }, u.features.map((f) => h("div", { class: "hbar-row ai", title: `${f.name}: ${cents(f.cost)} · ${f.calls} calls · ${tokens(f.tokens)} tokens` },
          h("div", { class: "hbar-label" }, f.name, f.oneTime ? h("span", { class: "muted small" }, " (one-time)") : null),
          h("div", { class: "hbar-track" }, h("i", { style: { width: `${(f.cost / fmax) * 100}%` } })),
          h("div", { class: "num small" }, `${f.calls} call${f.calls === 1 ? "" : "s"}`),
          h("div", { class: "num" }, cents(f.cost))))) : h("p", { class: "muted" }, "Nothing yet this month."),
        u.models.length ? h("p", { class: "small muted", style: { marginTop: "12px" } }, "Models: ", u.models.map((m) => `${m.name} ${cents(m.cost)}`).join(" · ")) : null,
        h("p", { class: "small muted" }, "Estimated from each response's token counts at Anthropic's list prices; your Anthropic bill is the final word."))),
  ];
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

/** Weekday × hour of new tickets (store time). Sequential: one hue, lighter = fewer. */
function heatmapCard(grid) {
  const max = Math.max(1, ...grid.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const hourLabel = (hr) => (hr === 0 ? "12a" : hr < 12 ? `${hr}a` : hr === 12 ? "12p" : `${hr - 12}p`);
  const table = h("table", { class: "tbl", hidden: true },
    h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "Busiest hour"), h("th", {}, "Tickets"))),
    h("tbody", {}, order.map((d) => {
      const row = grid[d];
      const best = row.indexOf(Math.max(...row));
      return h("tr", {}, h("td", {}, days[d]), h("td", {}, row[best] ? hourLabel(best) : "—"), h("td", { class: "num" }, row.reduce((a, b) => a + b, 0)));
    })));
  const heat = h("div", { class: "heat", role: "img", "aria-label": "New tickets by weekday and hour" },
    h("span"), Array.from({ length: 24 }, (_, hr) => h("span", { class: "heat-h" }, hr % 3 === 0 ? hourLabel(hr) : "")),
    order.map((d) => [h("span", { class: "heat-d" }, days[d]), grid[d].map((n, hr) =>
      h("i", { style: `--a:${n ? (0.15 + 0.85 * (n / max)).toFixed(3) : 0}`, title: `${days[d]} ${hourLabel(hr)}: ${n} ticket${n === 1 ? "" : "s"}` }))]));
  const toggle = h("button", { class: "btn sm ghost" }, "Show table");
  toggle.onclick = () => { table.hidden = !table.hidden; heat.hidden = !table.hidden; toggle.textContent = table.hidden ? "Show table" : "Show chart"; };
  return h("section", { class: "card" },
    h("div", { class: "row", style: { justifyContent: "space-between" } }, h("h2", {}, "When tickets arrive"), toggle),
    h("p", { class: "muted small", style: { margin: "0 0 10px" } }, "Eastern time · darker means more new tickets"), heat, table);
}

function teamCard(rows) {
  return h("section", { class: "card" }, h("h2", {}, "Team"),
    rows.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ["Teammate", "Replies", "Tickets answered", "Closed", "Open now"].map((x) => h("th", {}, x)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, h("b", {}, r.name)), h("td", { class: "num" }, r.replies), h("td", { class: "num" }, r.tickets_replied), h("td", { class: "num" }, r.closed), h("td", { class: "num" }, r.active)))))) : h("p", { class: "muted" }, "No activity yet."));
}

export function renderAnalytics(main) {
  const params = new URLSearchParams(location.search);
  let days = params.get("days") === "ytd" ? "ytd" : Number(params.get("days")) || 30;
  const body = h("div", { class: "stack", style: { gap: "16px" } }, h("div", { class: "card" }, skeletonRows(4)));
  const chips = h("div", { class: "view-chips" });
  let checkCard = null; // kept across period changes (it has its own period)
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between", paddingBottom: "16px" } },
        h("div", {}, h("h1", {}, "Dashboard"), h("p", { class: "sub", style: { margin: 0 } }, "Shipping costs versus what customers paid, how fast orders go out, and how support is keeping up.")),
        chips))),
    h("div", { class: "page-inner wide" }, body)));

  const load = async () => {
    mount(chips, PERIODS.map(([d, label]) => h("button", { class: "view-chip" + (d === days ? " active" : ""), onclick: () => { days = d; history.replaceState(null, "", `/dashboard?days=${d}`); load(); } }, label)));
    let a;
    try {
      a = await api(`/analytics?days=${days}`);
      compareLabel = a.ytd ? "vs last year" : "vs prior";
    } catch (e) {
      return mount(body, h("div", { class: "notice bad" }, e.message));
    }
    const c = a.shipping.current;
    const p = a.shipping.previous;
    const sp = a.support;
    const aiEl = h("div", { class: "stack", style: { gap: "16px" } });
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
          a.states.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("thead", {}, h("tr", {}, ["State", "Labels", "Avg cost"].map((x) => h("th", {}, x)))),
            h("tbody", {}, a.states.map((r) => h("tr", {}, h("td", {}, r.state), h("td", {}, r.labels), h("td", { class: "num" }, usd(r.avg_cost))))))) : h("p", { class: "muted" }, "No labels in this period."))),
      h("h2", { class: "analytics-h" }, "Support"),
      h("div", { class: "kpis" },
        tile("New tickets", String(sp.created), a.ytd ? "this year" : `in the last ${days} days`),
        tile("Closed", String(sp.closed), "tickets closed"),
        tile("Open now", String(sp.open), `${sp.inProgress} in progress · ${sp.snoozed} snoozed`),
        tile("First reply", hours(sp.medianFirstReplyHours), `median, ${sp.replied} replied`),
        tile("Resolution time", hours(sp.medianResolutionHours), `median, ${sp.resolved} resolved`),
        tile("Replies per ticket", sp.avgTouches == null ? "—" : sp.avgTouches.toFixed(1), "average for resolved tickets"),
        tile("One-touch", sp.oneTouchRate == null ? "—" : `${Math.round(sp.oneTouchRate * 100)}%`, "resolved with a single reply")),
      h("div", { class: "grid2 analytics-2" }, heatmapCard(sp.heatmap), teamCard(sp.team)),
      aiEl,
      h("section", { class: "card" }, h("h2", {}, "Recent labels"),
        a.recent.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
          h("thead", {}, h("tr", {}, ["Order", "Customer chose", "Shipped with", "Paid", "Label", "Margin"].map((x) => h("th", {}, x)))),
          h("tbody", {}, a.recent.map((r) => {
            const m = r.shipping_paid == null ? null : r.shipping_paid - r.cost;
            return h("tr", {}, h("td", {}, r.order_name || "—"), h("td", {}, r.requested_service || "—"), h("td", {}, r.service_name),
              h("td", { class: "num" }, r.shipping_paid == null ? "—" : usd(r.shipping_paid)), h("td", { class: "num" }, usd(r.cost)),
              h("td", { class: "num margin " + (m === null ? "" : m >= 0 ? "pos" : "neg") }, m === null ? "—" : `${m >= 0 ? "+" : "−"}${usd(Math.abs(m))}`));
          })))) : h("p", { class: "muted" }, "No labels in this period.")),
      checkCard ??= rateCheckCard()
    );
    api("/analytics/ai-usage").then((u) => mount(aiEl, h("h2", { class: "analytics-h" }, "AI usage"), aiUsageCard(u))).catch(() => mount(aiEl));
  };
  load().catch((e) => toast(e.message, true));
  return () => {};
}
