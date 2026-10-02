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
  chart: P('<path d="M3 3v18h18"/><path d="M7 15v2M11 11v6M15 7v10M19 12v5"/>'),
  info: P('<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5M12 8h.01"/>'),
  moon: P('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  at: P('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  tag: P('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>'),
  flag: P('<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>'),
  dots: P('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  merge: P('<path d="M6 3v6a6 6 0 0 0 6 6h6"/><path d="m15 12 3 3-3 3"/><path d="M6 21v-6"/>'),
  trash: P('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>'),
  spam: P('<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>'),
  archive: P('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>'),
  reply: P('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/>'),
  replyAll: P('<path d="M7 14 2 9l5-5"/><path d="M12 14 7 9l5-5"/><path d="M7 9h8a6 6 0 0 1 6 6v4"/>'),
  forward: P('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v4"/>'),
  download: P('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'),
  filter: P('<path d="M3 5h18M6 12h12M10 19h4"/>'),
  percent: P('<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
  bolt: P('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  activity: P('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  eye: P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  chevron: P('<path d="m6 9 6 6 6-6"/>'),
  up: P('<path d="m18 15-6-6-6 6"/>'),
  down: P('<path d="m6 9 6 6 6-6"/>'),
  folder: P('<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'),
  layers: P('<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>'),
  copy: P('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  bold: P('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
  italic: P('<path d="M14 5h-4M14 19h-4M14 5l-4 14"/>'),
  underline: P('<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>'),
  strike: P('<path d="M5 12h14"/><path d="M16 7a4 4 0 0 0-4-2c-2.5 0-4 1.3-4 3s1.5 2.5 4 3M8 17a4 4 0 0 0 4 2c2.5 0 4-1.3 4-3"/>'),
  ul: P('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  ol: P('<path d="M10 6h10M10 12h10M10 18h10M4 4h1v4M4 18h2l-2-2.5a1 1 0 1 1 2-.5"/>'),
  link: P('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>'),
  eraser: P('<path d="m7 21-4-4 11-11 7 7-7 8z"/><path d="M14 21h7M9 11l6 6"/>'),
  book: P('<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 7h6"/>'),
  wrench: P('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  play: P('<path d="m6 3 14 9-14 9V3z"/>'),
  edit: P('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  keyboard: P('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
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

/** Popover anchored to a button (fixed position, flips above when there is no room). Closes on outside click / Escape. */
let openPop = null;
export function popover(anchor, content, { width = 280, align = "left", onClose } = {}) {
  closePopover();
  const pop = h("div", { class: "pop", role: "menu", style: { width: `${width}px` } }, content);
  document.body.append(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const ph = pop.offsetHeight;
    const below = r.bottom + 6 + ph < innerHeight - 8 || r.top < ph + 14;
    pop.style.top = `${below ? r.bottom + 6 : r.top - 6 - ph}px`;
    let left = align === "right" ? r.right - width : r.left;
    left = Math.max(8, Math.min(innerWidth - width - 8, left));
    pop.style.left = `${left}px`;
  };
  place();
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePopover(); anchor.focus?.(); } };
  setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
  document.addEventListener("keydown", onKey, true);
  addEventListener("resize", closePopover, { once: true });
  openPop = { pop, cleanup: () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey, true); onClose?.(); }, place };
  const first = pop.querySelector("input, button, [tabindex]");
  first?.focus();
  return openPop;
}
export function closePopover() {
  if (!openPop) return;
  const p = openPop;
  openPop = null;
  p.pop.remove();
  p.cleanup();
}

/** Arrow-key navigation between the buttons of a menu. */
export function menuKeys(container) {
  container.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...container.querySelectorAll("button:not([disabled])")];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  });
  return container;
}

export function menuList(items) {
  return menuKeys(h("div", { class: "pop-list" }, items.filter(Boolean).map((it) =>
    it === "-" ? h("hr") : it.heading ? h("div", { class: "pop-head" }, it.heading) :
      h("button", { class: (it.danger ? "danger" : "") + (it.active ? " on" : ""), disabled: it.disabled, onclick: () => { closePopover(); it.run(); } },
        it.icon ? icon(it.icon) : null, h("span", {}, it.label), it.hint ? h("kbd", {}, it.hint) : null))));
}

/** Centered dialog. Returns { el, close }. */
export function modal(title, body, { width = 560, onClose } = {}) {
  const prev = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey, true); onClose?.(); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === "Escape" && !document.querySelector(".pop")) { e.stopPropagation(); close(); } };
  const panel = h("div", { class: "modal-panel", role: "dialog", "aria-modal": "true", "aria-label": title, style: { width: `min(${width}px, calc(100vw - 24px))` } },
    h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "btn ghost sm icon-only", "aria-label": "Close", onclick: () => close() }, icon("x"))),
    h("div", { class: "modal-body" }, body));
  const wrap = h("div", { class: "modal" }, h("div", { class: "slide-scrim", onclick: () => close() }), panel);
  document.body.append(wrap);
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => panel.querySelector("input, textarea, [contenteditable], select, button.primary")?.focus(), 0);
  return { el: panel, close };
}

/** Toast with an action button (e.g. Undo). Returns a function that dismisses it. */
export function actionToast(msg, actionLabel, onAction, ms = 5000) {
  const btn = h("button", { class: "toast-action" }, actionLabel);
  const t = h("div", { class: "toast", role: "status" }, icon("send"), h("span", {}, msg), btn);
  document.getElementById("toasts").append(t);
  const timer = setTimeout(() => t.remove(), ms);
  btn.onclick = () => { clearTimeout(timer); t.remove(); onAction(); };
  return () => { clearTimeout(timer); t.remove(); };
}

/** One-line text box that wraps onto more lines as the text grows (for word lists in rules). */
export function growInput(attrs = {}) {
  const { value = "", ...rest } = attrs;
  const ta = h("textarea", { class: "input grow-input", rows: 1, ...rest });
  ta.value = value ?? "";
  const fit = () => { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener("input", fit);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); }); // stays a single value
  requestAnimationFrame(fit);
  new ResizeObserver(fit).observe(ta);
  return ta;
}
