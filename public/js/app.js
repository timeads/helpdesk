import { api } from "./api.js";
import { h, mount, icon, initials, toast } from "./ui.js";
import { renderInbox } from "./inbox.js";
import { renderShipping } from "./shipping.js";
import { renderSettings } from "./settings.js";
import { renderAnalytics } from "./analytics.js";
import { renderManual } from "./manual.js";

export const state = { me: null, appName: "Support", agents: [], counts: {}, views: [] };
const root = document.getElementById("app");
let mainEl, navEl, cleanup = null;

const VIEWS = [
  { id: "mine", label: "Your tickets", short: "Mine", icon: "user" },
  { id: "unassigned", label: "Unassigned", short: "Unassigned", icon: "question", desktopOnly: true },
  { id: "open", label: "Open", short: "Open", icon: "inbox" },
  { id: "in_progress", label: "In progress", short: "Waiting", icon: "clock" },
  { id: "snoozed", label: "Snoozed", short: "Snoozed", icon: "moon", minor: true },
  { id: "mentions", label: "Mentions", short: "@", icon: "at", minor: true },
  { id: "closed", label: "Closed", short: "Closed", icon: "check", minor: true },
];
const MORE_VIEWS = [
  { id: "all", label: "All tickets", icon: "layers" },
  { id: "archived", label: "Archived", icon: "archive" },
  { id: "spam", label: "Spam", icon: "spam" },
  { id: "deleted", label: "Trash", icon: "trash" },
];
export const viewLabel = (id) => {
  if (id === "pending") return "In progress";
  if (id?.startsWith("v:")) return state.views.find((v) => `v:${v.id}` === id)?.name ?? "View";
  return [...VIEWS, ...MORE_VIEWS].find((v) => v.id === id)?.label ?? "Open";
};

export async function refreshViews() {
  try {
    state.views = (await api("/views")).views;
  } catch { /* keep what we had */ }
  renderNav();
}

let moreOpen = (() => { try { return localStorage.getItem("nav:more") === "1"; } catch { return false; } })();

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
addEventListener("popstate", () => route());

export async function refreshCounts() {
  try {
    state.counts = await api("/tickets/counts");
    renderNav();
  } catch {
    /* offline or signed out */
  }
}

function renderNav() {
  if (!navEl) return;
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  const inInbox = path === "/" || path.startsWith("/tickets");
  const isDash = path.startsWith("/dashboard") || path.startsWith("/analytics");
  const view = params.get("view") || "open";
  const item = (href, label, short, iconName, active, count, extra = "") =>
    h("a", { href, "data-link": "", class: "nav-item" + (active ? " active" : "") + extra, title: label, "aria-current": active ? "page" : null },
      icon(iconName),
      h("span", { class: "label-long" }, label),
      h("span", { class: "label-short" }, short),
      count ? h("span", { class: "count" }, count) : null,
    );
  mount(navEl,
    h("a", { class: "brand", href: "/", "data-link": "", "aria-label": "Tuft the World support desk" }, h("img", { class: "brand-logo", src: "/img/logo.png", alt: "Tuft the World" }), h("span", { class: "sub" }, "Support desk")),
    item("/dashboard", "Dashboard", "Dashboard", "chart", isDash, undefined, " dash-item"),
    h("div", { class: "nav-scroll" },
      h("div", { class: "nav-label" }, "Tickets"),
      VIEWS.map((v) => item(`/?view=${v.id}`, v.label, v.short, v.icon, inInbox && (view === v.id || (v.id === "in_progress" && view === "pending")), v.id === "closed" ? 0 : state.counts[v.id], v.minor || v.desktopOnly ? " closed-view" : "")),
      h("button", { class: "nav-item nav-more closed-view", "aria-expanded": String(moreOpen), onclick: () => {
        moreOpen = !moreOpen;
        try { localStorage.setItem("nav:more", moreOpen ? "1" : "0"); } catch { /* ignore */ }
        renderNav();
      } }, icon(moreOpen ? "up" : "down"), h("span", { class: "label-long" }, moreOpen ? "Less" : "More")),
      moreOpen || MORE_VIEWS.some((v) => v.id === view) ? MORE_VIEWS.map((v) => item(`/?view=${v.id}`, v.label, v.label, v.icon, inInbox && view === v.id, v.id === "spam" ? state.counts.spam : 0, " closed-view")) : null,
      state.views.length ? viewGroups().map(([folder, vs]) => [
        h("div", { class: "nav-label closed-view" }, folder || "Views"),
        vs.map((v) => item(`/?view=v:${v.id}`, v.name, v.name, folder ? "folder" : "layers", inInbox && view === `v:${v.id}`, state.counts[`v:${v.id}`], " closed-view")),
      ]) : null),
    h("div", { class: "nav-label" }, "Store"),
    item("/shipping", "Shipping", "Ship", "truck", path.startsWith("/shipping"), undefined, " ship-view"),
    item("/manual", "Repair manual", "Manual", "wrench", path.startsWith("/manual"), undefined, " ship-view"),
    item("/settings", "Settings", "Settings", "settings", path.startsWith("/settings")),
    h("div", { class: "spacer" }),
    h("div", { class: "me" },
      h("div", { class: "avatar" }, initials(state.me.name)),
      h("div", { style: { minWidth: 0, flex: 1 } },
        h("div", { class: "name" }, state.me.name),
        h("button", { title: "Sign out", "aria-label": "Sign out", onclick: async () => {
          await fetch("/auth/logout", { method: "POST" });
          location.href = "/";
        } }, icon("logout"), h("span", {}, "Sign out")),
      ),
    ),
  );
}

function viewGroups() {
  const groups = new Map();
  for (const v of state.views) {
    const k = v.folder || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])));
}

let section = null;
function route() {
  renderNav();
  const path = location.pathname;
  const next = path.startsWith("/shipping") ? "shipping" : path.startsWith("/manual") ? "manual" : path.startsWith("/settings") ? "settings" : path.startsWith("/dashboard") || path.startsWith("/analytics") ? "analytics" : "inbox";
  // Moving between tickets keeps the inbox mounted; anything else re-renders
  if (next !== "inbox" || section !== "inbox") {
    if (cleanup) cleanup();
    cleanup = null;
    mainEl.className = "main";
  }
  section = next;
  if (next === "shipping") cleanup = renderShipping(mainEl);
  else if (next === "analytics") cleanup = renderAnalytics(mainEl);
  else if (next === "settings") cleanup = renderSettings(mainEl);
  else if (next === "manual") cleanup = renderManual(mainEl);
  else cleanup = renderInbox(mainEl);
}

function renderLogin() {
  root.className = "login";
  const err = new URLSearchParams(location.search).get("error");
  mount(root,
    h("div", { class: "login-wrap" },
      h("main", { class: "login-card" },
        h("h1", { style: { margin: 0 } }, h("img", { class: "login-logo", src: "/img/logo.png", alt: "Tuft the World" })),
        h("div", { class: "sub" }, "Support desk"),
        h("p", {}, "Every email to support@ in one queue, with the customer's orders beside it."),
        err ? h("div", { class: "notice bad", style: { marginBottom: "16px", textAlign: "left" } }, err) : null,
        h("a", { class: "btn dark", href: "/auth/login" }, icon("mail"), "Sign in with Google"),
        h("p", { class: "fine" }, "Team members only. Ask an admin to add your email."),
      ),
    ),
  );
}

async function boot() {
  try {
    const me = await api("/me");
    state.me = me.agent;
    state.appName = me.appName;
  } catch {
    return renderLogin();
  }
  const err = new URLSearchParams(location.search).get("error");
  if (err) toast(err, true);
  [state.agents, state.views] = await Promise.all([api("/agents").then((r) => r.agents), api("/views").then((r) => r.views).catch(() => [])]);
  root.className = "";
  navEl = h("nav", { class: "sidebar" });
  mainEl = h("main", { class: "main" });
  mount(root, navEl, mainEl);
  route();
  refreshCounts();
  setInterval(refreshCounts, 30000);
}

boot();
