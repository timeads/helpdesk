// Dashboard → Rate check: shipments that went out through Redo, re-quoted with your own accounts
// (UPS direct + every EasyPost carrier) to show where Redo's rates beat yours, by weight and box.
import { api } from "./api.js";
import { h, mount, money, toast, icon } from "./ui.js";

const usd = (n) => money(n ?? 0, "USD");
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`;
const BANDS = [[1, "Under 1 lb"], [5, "1–5 lb"], [10, "5–10 lb"], [20, "10–20 lb"], [40, "20–40 lb"], [Infinity, "40 lb +"]];
const bandOf = (w) => BANDS.find(([max]) => w < max)[1];
const PERIODS = [[30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "12 months"]];

/** Our best rate minus what Redo paid: above zero, Redo was cheaper. */
const gapOf = (r) => r.best_total - r.redo_cost;
const gapCell = (g, extra = "") => h("td", { class: `num margin ${g > 0.005 ? "neg" : g < -0.005 ? "pos" : ""}`, title: g > 0 ? "Redo was cheaper" : "You'd pay less" }, signed(g), extra);

function group(rows, keyOf, order) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort((a, b) => m.get(b).length - m.get(a).length);
  return keys.map((k) => {
    const rs = m.get(k);
    const redo = rs.reduce((n, r) => n + r.redo_cost, 0);
    const ours = rs.reduce((n, r) => n + r.best_total, 0);
    const wins = {};
    for (const r of rs) wins[r.best_carrier] = (wins[r.best_carrier] ?? 0) + 1;
    const top = Object.entries(wins).sort((a, b) => b[1] - a[1])[0];
    return { key: k, n: rs.length, redo, ours, gap: ours - redo, redoWins: rs.filter((r) => gapOf(r) > 0.005).length, top };
  });
}

function groupTable(title, firstCol, groups) {
  return h("div", {},
    h("h3", { class: "section" }, title),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, [firstCol, "Orders", "Redo avg", "Your best avg", "Difference / order", "Redo cheaper on", "Usually cheapest"].map((x, i) => h("th", { class: i && i < 5 ? "num" : "" }, x)))),
      h("tbody", {}, groups.map((g) => h("tr", {},
        h("td", { style: { whiteSpace: "nowrap" } }, h("b", {}, g.key)),
        h("td", { class: "num" }, g.n),
        h("td", { class: "num" }, usd(g.redo / g.n)),
        h("td", { class: "num" }, usd(g.ours / g.n)),
        gapCell(g.gap / g.n),
        h("td", {}, `${g.redoWins} of ${g.n}`),
        h("td", { class: "small" }, g.top ? `${g.top[0]} (${g.top[1]})` : "—")))))));
}

function carrierTable(rows) {
  const per = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.carriers ?? {})) {
      const p = per.get(k) ?? { n: 0, gap: 0, cheapest: 0, beatsRedo: 0 };
      p.n++;
      p.gap += v.total - r.redo_cost;
      if (v.total < r.redo_cost - 0.005) p.beatsRedo++;
      if (r.best_carrier === k) p.cheapest++;
      per.set(k, p);
    }
  }
  const list = [...per.entries()].sort((a, b) => b[1].cheapest - a[1].cheapest || a[1].gap / a[1].n - b[1].gap / b[1].n);
  return h("div", {},
    h("h3", { class: "section" }, "By carrier"),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ["Carrier", "Quoted", "Cheapest of yours", "Beats Redo", "Vs Redo / order"].map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, list.map(([k, p]) => h("tr", {},
        h("td", {}, h("b", {}, k)),
        h("td", { class: "num" }, p.n),
        h("td", { class: "num" }, p.cheapest),
        h("td", { class: "num" }, `${p.beatsRedo} of ${p.n}`),
        gapCell(p.gap / p.n)))))));
}

function ordersTable(rows) {
  const sorted = [...rows].sort((a, b) => gapOf(b) - gapOf(a));
  const body = h("tbody");
  let all = false;
  const more = h("button", { class: "btn sm ghost" });
  const draw = () => {
    mount(body, (all ? sorted : sorted.slice(0, 15)).map((r) => h("tr", {},
      h("td", {}, h("b", {}, r.order_name || "—"), h("div", { class: "small muted" }, (r.shipped_at || "").slice(0, 10))),
      h("td", { class: "small" }, `${r.box_name ?? "—"} · ${r.weight ?? "?"} lb`, r.boxes !== r.redo_boxes ? h("div", { class: "muted" }, `Redo used ${r.redo_boxes} box${r.redo_boxes === 1 ? "" : "es"}`) : null),
      h("td", { class: "num" }, usd(r.redo_cost), h("div", { class: "small muted" }, r.redo_service || "")),
      h("td", { class: "num" }, usd(r.best_total), h("div", { class: "small muted" }, r.best_service || "")),
      h("td", { class: "num" }, r.same_total == null ? "—" : usd(r.same_total), r.same_service ? h("div", { class: "small muted" }, r.same_service) : null),
      gapCell(gapOf(r)))));
    more.hidden = sorted.length <= 15;
    more.textContent = all ? "Show fewer" : `Show all ${sorted.length}`;
  };
  more.onclick = () => { all = !all; draw(); };
  draw();
  return h("div", {},
    h("h3", { class: "section" }, "Orders, biggest Redo advantage first"),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, ["Order", "Your box & weight", "Redo paid", "Your best", "Same service", "Difference"].map((x, i) => h("th", { class: i >= 2 ? "num" : "" }, x)))),
      body)),
    h("div", { class: "row", style: { marginTop: "8px" } }, more));
}

export function rateCheckCard() {
  const el = h("section", { class: "card", id: "rate-check" });
  let days = 90;
  let running = false;
  let rows = null;

  const run = async (restart) => {
    if (running) return;
    running = true;
    let done = 0;
    let total = null;
    const bar = h("i", { style: { width: "0%" } });
    const note = h("div", { class: "small muted" }, "Starting…");
    draw(h("div", {}, h("div", { class: "progress" }, bar), note));
    try {
      let first = true;
      for (;;) {
        const r = await api("/rate-check/run", { method: "POST", body: { days, restart: restart && first } });
        first = false;
        done += r.checked;
        total ??= r.remaining + r.checked;
        bar.style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
        note.textContent = `Re-quoted ${done} of ${total} shipments…`;
        if (!r.remaining || !r.checked) break;
      }
    } catch (e) {
      toast(`Rate check stopped: ${e.message}`, true);
    } finally {
      running = false;
    }
    await load();
  };

  const controls = () => {
    const seg = h("div", { class: "seg" }, PERIODS.map(([d, t]) => h("button", { class: d === days ? "on" : "", onclick: () => { days = d; draw(); } }, t)));
    return h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } },
      h("span", { class: "small muted" }, "Redo shipments from the last"), seg,
      h("button", { class: "btn primary sm", disabled: running, onclick: () => run(false) }, icon("refresh"), rows?.length ? "Check new shipments" : "Run rate check"),
      rows?.length ? h("button", { class: "btn sm ghost", disabled: running, onclick: () => confirm("Re-quote every shipment from scratch with today's rates?") && run(true) }, "Start over") : null);
  };

  function draw(progress) {
    const ok = (rows ?? []).filter((r) => !r.error && r.best_total != null && r.redo_cost > 0);
    const skipped = (rows ?? []).filter((r) => r.error);
    const reasons = {};
    for (const r of skipped) reasons[r.error.replace(/^(EasyPost|UPS)[^:]*: .*/, "$1 error")] = (reasons[r.error.replace(/^(EasyPost|UPS)[^:]*: .*/, "$1 error")] ?? 0) + 1;
    const redo = ok.reduce((n, r) => n + r.redo_cost, 0);
    const ours = ok.reduce((n, r) => n + r.best_total, 0);
    const same = ok.filter((r) => r.same_total != null);
    const sameGap = same.reduce((n, r) => n + r.same_total - r.redo_cost, 0);
    const redoWins = ok.filter((r) => gapOf(r) > 0.005).length;
    mount(el,
      h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" } },
        h("div", { style: { minWidth: 0, flex: "1 1 320px" } },
          h("h2", {}, "Rate check: Redo vs your accounts"),
          h("p", { class: "muted", style: { margin: "4px 0 0" } }, "Re-quotes orders you shipped through Redo with your UPS account and every carrier on EasyPost, using the boxes and weights this app would pick today (box memory, rules, product weights) and today's rates. Shows where Redo's rates beat yours.")),
        controls()),
      progress ?? null,
      rows === null ? h("p", { class: "muted" }, "Loading…")
        : !rows.length ? h("div", { class: "notice info", style: { marginTop: "12px" } }, "Nothing checked yet. Run the rate check to re-quote recent Redo shipments (it takes a few seconds per order and doesn't buy anything).")
        : h("div", { class: "stack", style: { gap: "16px", marginTop: "14px" } },
          ok.length ? h("div", { class: "kpis" },
            h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Orders compared"), h("div", { class: "kpi-value" }, String(ok.length)), h("div", { class: "kpi-sub" }, skipped.length ? `${skipped.length} skipped` : "all checked")),
            h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Redo paid"), h("div", { class: "kpi-value" }, usd(redo)), h("div", { class: "kpi-sub" }, `avg ${usd(redo / ok.length)} per order`)),
            h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Your cheapest rates"), h("div", { class: "kpi-value" }, usd(ours)), h("div", { class: "kpi-sub" }, h("span", { class: ours > redo ? "neg" : "pos" }, `${signed(ours - redo)} (${redo ? `${((ours - redo) / redo * 100).toFixed(0)}%` : "—"})`), " vs Redo")),
            h("div", { class: "kpi" }, h("div", { class: "kpi-label" }, "Redo cheaper on"), h("div", { class: "kpi-value" }, `${redoWins} of ${ok.length}`), h("div", { class: "kpi-sub" }, same.length ? h("span", {}, "Same service, your UPS: ", h("span", { class: sameGap > 0 ? "neg" : "pos" }, `${signed(sameGap / same.length)}/order`)) : "orders"))) : null,
          ok.length ? groupTable("By weight", "Weight", group(ok, (r) => bandOf(r.weight ?? 0), BANDS.map((b) => b[1]))) : null,
          ok.length ? groupTable("By box", "Box", group(ok, (r) => r.box_name || "—")) : null,
          ok.length ? carrierTable(ok) : null,
          ok.length ? ordersTable(ok) : null,
          skipped.length ? h("p", { class: "small muted" }, `Skipped: ${Object.entries(reasons).map(([k, n]) => `${k} (${n})`).join(" · ")}`) : null,
          h("p", { class: "small muted" }, "Difference = your cheapest rate − what Redo paid; red means Redo was cheaper. Weights come from box memory or product weights, so a light box or a missing product weight skews a row — check the biggest gaps against the order.")));
  }

  const load = async () => {
    try {
      rows = (await api("/rate-check")).rows;
    } catch (e) {
      rows = [];
      toast(e.message, true);
    }
    draw();
  };
  draw();
  load();
  return el;
}
