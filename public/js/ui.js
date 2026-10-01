// Small DOM + formatting helpers. h() builds elements without innerHTML so email content is never parsed as markup.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v; // only for trusted, static markup (icons)
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function toast(msg, isError = false) {
  const t = h("div", { class: "toast" + (isError ? " err" : ""), role: isError ? "alert" : "status" }, icon(isError ? "info" : "check"), msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3000);
}

export function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 6) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

export function fullTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function money(amount, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(Number(amount));
}

export function initials(name = "") {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
}

export function humanize(s = "") {
  return s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function fileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const P = (d) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icons = {
  inbox: P('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  user: P('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  question: P('<circle cx="12" cy="12" r="9.5"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 2.6"/><path d="M12 17h.01"/>'),
  clock: P('<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3.5 2"/>'),
  check: P('<path d="M20 6 9 17l-5-5"/>'),
  truck: P('<path d="M2 5h12v11H2z"/><path d="M14 9h4.5l3.5 3.8V16h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>'),
  settings: P('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  refresh: P('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  clip: P('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  spark: P('<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>'),
  back: P('<path d="M15 18l-6-6 6-6"/>'),
  ext: P('<path d="M7 17 17 7M8 7h9v9"/>'),
  x: P('<path d="M18 6 6 18M6 6l12 12"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  note: P('<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>'),
  mail: P('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  bag: P('<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  box: P('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'),
  printer: P('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  send: P('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  logout: P('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>'),
  info: P('<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5M12 8h.01"/>'),
};

export function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = icons[name];
  return t.content.firstChild;
}

/** Inbox-zero art: a round tufted rug seen from above, in brand yarns. */
export function rugArt() {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="art" viewBox="0 0 120 120" aria-hidden="true">
    <circle cx="60" cy="60" r="54" fill="#213838"/>
    <circle cx="60" cy="60" r="46" fill="none" stroke="#c78c2b" stroke-width="7" stroke-dasharray="3 2.4"/>
    <circle cx="60" cy="60" r="35" fill="none" stroke="#cec6bf" stroke-width="7" stroke-dasharray="3 2.4"/>
    <circle cx="60" cy="60" r="24" fill="none" stroke="#b03424" stroke-width="7" stroke-dasharray="3 2.4"/>
    <circle cx="60" cy="60" r="13" fill="#b4eaba"/>
    <path d="M54 60.5l4.2 4.2L67 56" fill="none" stroke="#213838" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return t.content.firstChild;
}

export function skeletonRows(n = 6) {
  return Array.from({ length: n }, (_, i) =>
    h("div", { class: "skel", "aria-hidden": "true" },
      h("i", { style: { width: `${45 + ((i * 17) % 30)}%` } }),
      h("i", { style: { width: `${70 + ((i * 11) % 25)}%` } }),
      h("i", { style: { width: `${55 + ((i * 13) % 35)}%`, opacity: 0.6 } })));
}

export function spinner() {
  return h("span", { class: "spinner", role: "status", "aria-label": "Loading" });
}

/** Wraps an async click handler: disables the button and shows errors as toasts. */
export function busy(btn, fn) {
  return async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message || String(e), true);
    } finally {
      btn.disabled = false;
    }
  };
}
