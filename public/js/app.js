import { api } from "./api.js";
import { h, mount, icon, initials, toast } from "./ui.js";
import { renderInbox } from "./inbox.js";
import { renderShipping } from "./shipping.js";
import { renderSettings } from "./settings.js";

export const state = { me: null, appName: "Support", agents: [], counts: {} };
const root = document.getElementById("app");
let mainEl, navEl, cleanup = null;

const VIEWS = [
  { id: "mine", label: "Assigned to me", short: "Mine", icon: "user" },
  { id: "unassigned", label: "Unassigned", short: "Unassigned", icon: "question" },
  { id: "open", label: "All open", short: "Open", icon: "inbox" },
  { id: "pending", label: "Waiting on customer", nav: "Pending", short: "Pending", icon: "clock" },
  { id: "closed", label: "Closed", short: "Closed", icon: "check" },
];
export const viewLabel = (id) => VIEWS.find((v) => v.id === id)?.label ?? "All open";

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
  const view = params.get("view") || "open";
  const item = (href, label, short, iconName, active, count, extra = "") =>
    h("a", { href, "data-link": "", class: "nav-item" + (active ? " active" : "") + extra, title: label, "aria-current": active ? "page" : null },
      icon(iconName),
      h("span", { class: "label-long" }, label),
      h("span", { class: "label-short" }, short),
      count ? h("span", { class: "count" }, count) : null,
    );
  mount(navEl,
    h("a", { class: "brand", href: "/", "data-link": "" }, h("span", { class: "word" }, "Tuft the World"), h("span", { class: "sub" }, "Support desk")),
    h("div", { class: "nav-label" }, "Tickets"),
    VIEWS.map((v) => item(`/?view=${v.id}`, v.nav ?? v.label, v.short, v.icon, inInbox && view === v.id, state.counts[v.id], v.id === "closed" ? " closed-view" : "")),
    h("div", { class: "nav-label" }, "Store"),
    item("/shipping", "Shipping", "Ship", "truck", path.startsWith("/shipping"), undefined, " ship-view"),
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

let section = null;
function route() {
  renderNav();
  const path = location.pathname;
  const next = path.startsWith("/shipping") ? "shipping" : path.startsWith("/settings") ? "settings" : "inbox";
  // Moving between tickets keeps the inbox mounted; anything else re-renders
  if (next !== "inbox" || section !== "inbox") {
    if (cleanup) cleanup();
    cleanup = null;
    mainEl.className = "main";
  }
  section = next;
  if (next === "shipping") cleanup = renderShipping(mainEl);
  else if (next === "settings") cleanup = renderSettings(mainEl);
  else cleanup = renderInbox(mainEl);
}

function renderLogin() {
  root.className = "login";
  const err = new URLSearchParams(location.search).get("error");
  mount(root,
    h("div", { class: "login-wrap" },
      h("main", { class: "login-card" },
        h("h1", { class: "word", style: { margin: 0 } }, "Tuft the World"),
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
  state.agents = (await api("/agents")).agents;
  root.className = "";
  navEl = h("nav", { class: "sidebar" });
  mainEl = h("main", { class: "main" });
  mount(root, navEl, mainEl);
  route();
  refreshCounts();
  setInterval(refreshCounts, 30000);
}

boot();
