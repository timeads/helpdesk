// Ticket list: views, filters, bulk actions, CSV export, keyboard shortcuts. The ticket itself lives in ticket.js.
import { api } from "./api.js";
import { state, navigate, refreshCounts, viewLabel, refreshViews } from "./app.js";
import { h, mount, icon, relTime, fullTime, initials, toast, busy, rugArt, skeletonRows, popover, menuList, modal } from "./ui.js";
import { statusLabel, statusBadge, PRIORITY, priorityChip, statusMenu, priorityMenu, assignMenu, snoozeMenu, tagMenu, loadTags, tagChips, whenLabel } from "./common.js";
import { openTicket } from "./ticket.js";
import { newEmail, loadSettings } from "./composer.js";

let inst = null; // the mounted inbox, reused while moving between tickets

const FILTER_KEYS = ["tag", "assignee", "priority", "unread", "sort"];

function parseLocation() {
  const params = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/tickets\/(\d+)/);
  const filters = {};
  for (const k of FILTER_KEYS) if (params.get(k)) filters[k] = params.get(k);
  return { view: params.get("view") || "open", q: params.get("q") || "", ticketId: m ? Number(m[1]) : null, filters };
}

const filterKey = (f) => FILTER_KEYS.map((k) => f[k] ?? "").join("|");

export function renderInbox(main) {
  const loc = parseLocation();
  if (inst && inst.main === main && inst.view === loc.view && filterKey(inst.filters) === filterKey(loc.filters) && main.isConnected && main.contains(inst.listPane)) {
    inst.select(loc.ticketId);
    return inst.cleanup;
  }
  inst?.cleanup();
  inst = createInbox(main, loc);
  return inst.cleanup;
}

const MIXED_VIEWS = new Set(["all", "mentions", "mine"]);

function createInbox(main, loc) {
  const self = { main, view: loc.view, q: loc.q, filters: { ...loc.filters }, tickets: [], more: false, ticketId: null, detail: null, selected: new Set() };
  const qs = () => {
    const p = new URLSearchParams({ view: self.view });
    for (const [k, v] of Object.entries(self.filters)) if (v) p.set(k, v);
    return p;
  };
  const ticketHref = (id) => `/tickets/${id}?${qs()}`;
  self.href = ticketHref;

  const listEl = h("div", { class: "list", role: "list" }, skeletonRows());
  const search = h("input", { class: "input", type: "search", placeholder: "Search tickets and messages", title: "Search names, emails, subjects, message text or #ticket", value: self.q, "aria-label": "Search tickets" });
  const syncBtn = h("button", { class: "btn ghost sm icon-only", title: "Check Gmail for new mail now", "aria-label": "Check for new mail" }, icon("refresh"));
  const newBtn = h("button", { class: "btn ghost sm icon-only", title: "New email (c)", "aria-label": "New email", onclick: () => newEmail() }, icon("plus"));
  const moreBtn = h("button", { class: "btn ghost sm icon-only", title: "View options", "aria-label": "View options" }, icon("dots"));
  const filterBtn = h("button", { class: "btn ghost sm icon-only", title: "Filter and sort", "aria-label": "Filter and sort", "aria-expanded": "false" }, icon("filter"));
  const totalEl = h("span", { class: "total" });
  const titleEl = h("h1", {}, viewLabel(self.view));
  const titleRow = h("div", { class: "title-row" }, titleEl, totalEl, h("span", { class: "title-actions" }, filterBtn, newBtn, syncBtn, moreBtn));
  const bulkBar = h("div", { class: "bulk-bar", hidden: true, role: "toolbar", "aria-label": "Selected tickets" });
  const filterBar = h("div", { class: "filter-bar", hidden: true });
  const loadMore = h("button", { class: "btn sm load-more" }, "Show more");
  self.listPane = h("section", { class: "list-pane", "aria-label": "Tickets" },
    h("div", { class: "list-head" }, titleRow, bulkBar, h("div", { class: "search" }, icon("search"), search), filterBar),
    listEl);

  // ---- Filters
  const activeFilters = () => FILTER_KEYS.filter((k) => k !== "sort" && self.filters[k]).length;
  const applyFilters = () => navigate(`/?${qs()}`, { replace: true });
  const drawFilters = async () => {
    const tags = await loadTags().catch(() => []);
    const sel = (key, label, options) => {
      const s = h("select", { class: "input sm", "aria-label": label },
        h("option", { value: "" }, label), options.map(([v, l]) => h("option", { value: v, selected: self.filters[key] === v }, l)));
      s.onchange = () => { if (s.value) self.filters[key] = s.value; else delete self.filters[key]; applyFilters(); };
      return s;
    };
    const unread = h("label", { class: "check small" }, h("input", { type: "checkbox", checked: self.filters.unread === "1", onchange: (e) => { if (e.target.checked) self.filters.unread = "1"; else delete self.filters.unread; applyFilters(); } }), "Unread only");
    mount(filterBar,
      sel("tag", "Any tag", tags.map((t) => [t.name, t.name])),
      sel("assignee", "Anyone", [["me", "Me"], ["none", "Unassigned"], ...state.agents.filter((a) => a.id !== state.me.id).map((a) => [String(a.id), a.name])]),
      sel("priority", "Any priority", [...Object.entries(PRIORITY), ["none", "No priority"]]),
      sel("sort", "Newest activity", [["oldest", "Oldest activity"], ["waiting", "Waiting longest"], ["created", "Newest created"], ["priority", "Priority"]]),
      h("div", { class: "row", style: { gap: "4px", gridColumn: "1 / -1" } }, unread,
        activeFilters() ? h("button", { class: "btn sm ghost", style: { marginLeft: "auto" }, onclick: () => { self.filters = self.filters.sort ? { sort: self.filters.sort } : {}; applyFilters(); } }, "Clear") : null,
        activeFilters() ? h("button", { class: "btn sm", onclick: saveView }, "Save as view") : null));
  };
  filterBtn.onclick = () => {
    filterBar.hidden = !filterBar.hidden;
    filterBtn.setAttribute("aria-expanded", String(!filterBar.hidden));
    filterBtn.classList.toggle("on", !filterBar.hidden);
    if (!filterBar.hidden) drawFilters();
  };
  if (activeFilters() || self.filters.sort) { filterBar.hidden = false; filterBtn.classList.add("on"); drawFilters(); }

  async function saveView() {
    const name = h("input", { class: "input", placeholder: "e.g. Urgent repairs", "aria-label": "View name" });
    const folder = h("input", { class: "input", placeholder: "Optional", "aria-label": "Folder" });
    const go = h("button", { class: "btn primary" }, "Save view");
    const dlg = modal("Save as view", h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Folder"), folder),
      h("p", { class: "small muted", style: { margin: 0 } }, "The view keeps these filters and shows open and in-progress tickets. Edit it any time in Settings → Macros, tags & views."),
      h("div", { class: "row", style: { justifyContent: "flex-end" } }, go)), { width: 420 });
    go.onclick = busy(go, async () => {
      if (!name.value.trim()) return name.focus();
      const f = self.filters;
      const r = await api("/views", { method: "POST", body: { name: name.value.trim(), folder: folder.value.trim() || undefined, filters: {
        status: "active", tags_any: f.tag ? [f.tag] : undefined, assignee: f.assignee, priority: f.priority, unread: f.unread === "1" } } });
      dlg.close();
      await refreshViews();
      navigate(`/?view=v:${r.id}`);
    });
  }

  moreBtn.onclick = () => popover(moreBtn, menuList([
    { label: "Export this view (CSV)", icon: "download", run: () => { location.href = `/api/tickets/export.csv?${qs()}${self.q ? `&q=${encodeURIComponent(self.q)}` : ""}`; } },
    { label: "Keyboard shortcuts", icon: "keyboard", hint: "?", run: shortcutsHelp },
    { label: "Manage views", icon: "layers", run: () => navigate("/settings/macros#views") },
  ]), { width: 250, align: "right" });

  // ---- Bulk actions
  const renderBulk = () => {
    const n = self.selected.size;
    titleRow.hidden = n > 0;
    bulkBar.hidden = n === 0;
    listEl.classList.toggle("selecting", n > 0);
    if (!n) return;
    const all = self.tickets.length > 0 && self.tickets.every((t) => self.selected.has(t.id));
    const allBox = h("input", { type: "checkbox", checked: all, "aria-label": all ? "Deselect all" : "Select all" });
    allBox.indeterminate = !all;
    allBox.onchange = () => {
      if (all) self.selected.clear();
      else self.tickets.forEach((t) => self.selected.add(t.id));
      renderList();
    };
    const run = async (body, msg) => {
      const ids = [...self.selected];
      try {
        await api("/tickets/bulk", { method: "POST", body: { ids, ...body } });
        toast(`${ids.length} ticket${ids.length > 1 ? "s" : ""} ${msg}`);
        self.selected.clear();
        if (body.status && ids.includes(self.ticketId)) navigate(`/?${qs()}`);
        await loadList();
        refreshCounts();
      } catch (e) { toast(e.message, true); }
    };
    const closing = !["closed", "archived"].includes(self.view);
    const closeBtn = h("button", { class: "btn sm primary", onclick: () => run({ status: closing ? "closed" : "open" }, closing ? "closed" : "reopened") }, icon(closing ? "check" : "inbox"), closing ? "Close" : "Reopen");
    const statusBtn = h("button", { class: "btn sm", title: "Status" }, "Status", icon("chevron"));
    statusBtn.onclick = () => statusMenu(statusBtn, null, (s, until) => run({ status: s, snooze_until: until }, s === "snoozed" ? `snoozed until ${whenLabel(until)}` : `marked ${statusLabel(s).toLowerCase()}`));
    const assignBtn = h("button", { class: "btn sm icon-only", title: "Assign", "aria-label": "Assign" }, icon("user"));
    assignBtn.onclick = () => assignMenu(assignBtn, undefined, (id) => run({ assignee_id: id }, id ? `assigned to ${id === state.me.id ? "you" : state.agents.find((a) => a.id === id)?.name}` : "unassigned"));
    const tagBtn = h("button", { class: "btn sm icon-only", title: "Tags", "aria-label": "Tags" }, icon("tag"));
    tagBtn.onclick = () => popover(tagBtn, menuList([
      { label: "Add tag…", icon: "plus", run: () => setTimeout(() => tagMenu(tagBtn, [], (name) => run({ add_tags: [name] }, `tagged ${name}`), { mode: "add" }), 0) },
      { label: "Remove tag…", icon: "x", run: () => {
        const on = [...new Set(self.tickets.filter((t) => self.selected.has(t.id)).flatMap((t) => t.tags))];
        setTimeout(() => tagMenu(tagBtn, on, (name) => run({ remove_tags: [name] }, `untagged ${name}`), { mode: "remove" }), 0);
      } },
    ]), { width: 200 });
    const more = h("button", { class: "btn sm icon-only", title: "More", "aria-label": "More bulk actions" }, icon("dots"));
    more.onclick = () => popover(more, menuList([
      { label: "Set priority…", icon: "flag", run: () => setTimeout(() => priorityMenu(more, undefined, (p) => run({ priority: p }, p ? `set to ${PRIORITY[p].toLowerCase()} priority` : "cleared priority")), 0) },
      { label: "Snooze…", icon: "moon", run: () => setTimeout(() => snoozeMenu(more, (until) => run({ status: "snoozed", snooze_until: until }, `snoozed until ${whenLabel(until)}`)), 0) },
      { label: "Mark as read", icon: "eye", run: () => run({ unread: false }, "marked read") },
      { label: "Mark as unread", icon: "eye", run: () => run({ unread: true }, "marked unread") },
      n > 1 ? { label: "Merge selected…", icon: "merge", run: mergeSelected } : null,
      { label: "Export selected (CSV)", icon: "download", run: () => { location.href = `/api/tickets/export.csv?ids=${[...self.selected].join(",")}`; } },
      "-",
      { label: "Mark as spam", icon: "spam", run: () => run({ status: "spam" }, "moved to spam") },
      { label: "Delete", icon: "trash", danger: true, run: () => run({ status: "deleted" }, "moved to trash") },
    ]), { width: 230, align: "right" });
    mount(bulkBar,
      h("label", { class: "bulk-all" }, allBox, h("b", {}, `${n} selected`)),
      h("div", { class: "row", style: { gap: "4px", marginLeft: "auto", flexWrap: "nowrap" } }, closeBtn, statusBtn, assignBtn, tagBtn, more,
        h("button", { class: "btn sm ghost icon-only", "aria-label": "Clear selection", title: "Clear selection (Esc)", onclick: () => { self.selected.clear(); renderList(); } }, icon("x"))));
  };

  const mergeSelected = () => {
    const picked = self.tickets.filter((t) => self.selected.has(t.id));
    const keep = h("div", { class: "merge-list" });
    let target = picked.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))[0].id;
    mount(keep, picked.map((t) => h("label", { class: "check merge-row" },
      h("input", { type: "radio", name: "keep", checked: t.id === target, onchange: () => { target = t.id; } }),
      h("div", {}, h("div", {}, h("b", {}, `#${t.id} `), t.subject), h("div", { class: "small muted" }, `${t.customer_name || t.customer_email} · ${relTime(t.last_message_at)}`)))));
    const go = h("button", { class: "btn primary" }, icon("merge"), "Merge");
    const dlg = modal(`Merge ${picked.length} tickets`, h("div", { class: "stack" },
      h("p", { class: "muted", style: { margin: 0 } }, "Pick the ticket to keep. The others move into it and go to Trash."), keep,
      h("div", { class: "row", style: { justifyContent: "flex-end" } }, go)), { width: 520 });
    go.onclick = busy(go, async () => {
      await api(`/tickets/${target}/merge`, { method: "POST", body: { ids: picked.map((t) => t.id).filter((id) => id !== target) } });
      dlg.close();
      toast("Merged");
      self.selected.clear();
      refreshCounts();
      navigate(ticketHref(target));
      loadList();
    });
  };

  const toggleSelect = (id) => {
    if (self.selected.has(id)) self.selected.delete(id);
    else self.selected.add(id);
    renderList();
  };
  const detailEl = h("section", { class: "detail" });
  mount(main, self.listPane, detailEl);

  let searchTimer;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { self.q = search.value.trim(); loadList(); }, 250);
  });
  syncBtn.addEventListener("click", busy(syncBtn, async () => {
    const r = await api("/tickets/sync", { method: "POST" });
    toast((r.created ? `${r.created} new ticket${r.created > 1 ? "s" : ""}` : r.imported ? `${r.imported} new message${r.imported > 1 ? "s" : ""}` : r.more ? "Importing" : "Inbox is up to date")
      + (r.more ? " — more mail is still coming in" : ""));
    await loadList();
    refreshCounts();
  }));
  loadMore.onclick = busy(loadMore, () => loadList(true));

  async function loadList(append = false) {
    const p = qs();
    if (self.q) p.set("q", self.q);
    if (append) p.set("offset", String(self.tickets.length));
    try {
      const { tickets, more } = await api("/tickets?" + p);
      self.tickets = append ? [...self.tickets, ...tickets] : tickets;
      self.more = more;
      renderList();
    } catch (e) {
      mount(listEl, h("div", { class: "empty" }, e.message));
    }
  }

  function renderList() {
    for (const id of self.selected) if (!self.tickets.some((t) => t.id === id)) self.selected.delete(id);
    renderBulk();
    titleEl.textContent = viewLabel(self.view);
    totalEl.textContent = self.tickets.length ? String(self.tickets.length) + (self.more ? "+" : "") : "";
    if (!self.tickets.length) {
      const zero = !self.q && !activeFilters() && ["open", "mine", "unassigned"].includes(self.view);
      mount(listEl, h("div", { class: "empty fade-in" },
        zero ? rugArt() : null,
        h("h2", {}, self.q ? "No matches" : zero ? "Inbox zero" : "Nothing here"),
        h("p", {}, self.q ? `Nothing matches “${self.q}”. Search covers names, emails, subjects, message text and ticket numbers.`
          : zero ? "New mail to support@ shows up here within a minute." : activeFilters() ? "No tickets match these filters." : "Tickets will appear here as their status changes.")));
      return;
    }
    const showStatus = MIXED_VIEWS.has(self.view) || self.view.startsWith("v:") || !!self.q;
    mount(listEl, self.tickets.map((t) =>
      h("a", { href: ticketHref(t.id), "data-link": "", role: "listitem", class: "t-row" + (t.unread ? " unread" : "") + (t.id === self.ticketId ? " active" : ""), "data-id": t.id },
        h("span", {
          class: "pick" + (self.selected.has(t.id) ? " on" : ""), role: "checkbox", tabindex: 0,
          "aria-checked": self.selected.has(t.id), "aria-label": `Select ticket from ${t.customer_name || t.customer_email}`,
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(t.id); },
          onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); toggleSelect(t.id); } },
        }, icon("check")),
        h("div", { class: "top" },
          h("span", { class: "who" }, t.customer_name || t.customer_email),
          h("span", { class: "when", title: fullTime(t.last_message_at) }, relTime(t.last_message_at))),
        h("div", { class: "subj" }, priorityChip(t.priority), t.channel === "chat" ? h("span", { class: "chat-tag", title: "Website chat" }, icon("chat"))
          : t.channel === "instagram" || t.channel === "facebook" ? h("span", { class: `chat-tag ${t.channel}`, title: t.channel === "instagram" ? "Instagram" : "Facebook" }, icon(t.channel)) : null, h("span", {}, t.subject)),
        h("div", { class: "snip" }, t.snippet),
        h("div", { class: "meta" },
          showStatus || t.status === "snoozed" ? statusBadge(t.status) : null,
          t.status === "snoozed" && t.snoozed_until ? h("span", { class: "small muted" }, whenLabel(t.snoozed_until)) : null,
          t.assignee_name
            ? h("span", { class: "assignee", title: `Assigned to ${t.assignee_name}` }, h("span", { class: "avatar" }, initials(t.assignee_name)), self.view === "mine" ? null : t.assignee_name.split(" ")[0])
            : t.status === "open" ? h("span", { class: "badge warn plain" }, "Unassigned") : null,
          tagChips(t.tags, 2),
          t.message_count > 1 ? h("span", { class: "small muted count", title: `${t.message_count} messages` }, t.message_count) : null),
      )), self.more ? loadMore : null);
  }

  function nextTicketId(afterId) {
    const i = self.tickets.findIndex((t) => t.id === afterId);
    const rest = self.tickets.filter((t) => t.id !== afterId);
    if (!rest.length) return null;
    return (i >= 0 && i < rest.length ? rest[i] : rest[0]).id;
  }

  self.goNext = (fromId) => {
    const next = nextTicketId(fromId);
    const go = () => {
      self.tickets = self.tickets.filter((t) => t.id !== fromId);
      renderList();
      navigate(next ? ticketHref(next) : `/?${qs()}`);
    };
    const row = listEl.querySelector(`.t-row[data-id="${fromId}"]`);
    if (row && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      row.classList.add("leaving");
      setTimeout(go, 180);
    } else go();
  };

  self.markRead = (id) => {
    const row = self.tickets.find((x) => x.id === id);
    if (row?.unread) {
      row.unread = 0;
      listEl.querySelector(`.t-row[data-id="${id}"]`)?.classList.remove("unread");
      refreshCounts();
    }
  };

  self.select = (id) => {
    self.ticketId = id;
    self.detail = null;
    main.classList.toggle("has-ticket", !!id);
    listEl.querySelectorAll(".t-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
    if (!id) {
      mount(detailEl, h("div", { class: "empty", style: { margin: "auto" } },
        h("h2", {}, self.tickets.length ? "Pick a ticket" : "Nothing to answer"),
        h("p", {}, "Press ", h("kbd", {}, "?"), " for keyboard shortcuts.")));
      return;
    }
    openTicket(self, detailEl, id);
  };

  // ---- Keyboard
  const onKey = (e) => {
    if (document.querySelector(".modal, .pop")) return;
    const typing = e.target.closest("input, textarea, select, [contenteditable]");
    const d = self.detail;
    // Alt shortcuts use the physical key (Alt+letter types accents on a Mac); never while typing
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (!d || typing) return;
      const act = { KeyC: d.close, KeyR: d.reopen, KeyI: d.inProgress, KeyM: d.spam }[e.code];
      if (act) { e.preventDefault(); act(); }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey) return;
    const i = self.tickets.findIndex((t) => t.id === self.ticketId);
    const k = e.key;
    if (k === "j" || k === "k") {
      const t = self.tickets[k === "j" ? i + 1 : Math.max(0, i - 1)];
      if (t) { e.preventDefault(); navigate(ticketHref(t.id)); }
    } else if (k === "?") shortcutsHelp();
    else if (k === "/") { e.preventDefault(); search.focus(); }
    else if (k === "c") newEmail();
    else if (k === "x" && self.ticketId) toggleSelect(self.ticketId);
    else if (k === "Escape" && self.selected.size) { self.selected.clear(); renderList(); }
    else if (d) {
      const map = { r: () => d.focusReply("reply"), n: () => d.focusReply("note"), f: () => d.focusReply("forward"), e: d.close, s: d.snooze, a: d.assign, t: d.tags, p: d.priority, m: d.assignToMe };
      if (map[k]) { e.preventDefault(); map[k](); }
    }
  };
  document.addEventListener("keydown", onKey);
  const poll = setInterval(() => { if (!document.hidden && !self.q && !self.selected.size) loadList(); }, 30000);

  self.cleanup = () => {
    document.removeEventListener("keydown", onKey);
    clearInterval(poll);
    inst = null;
  };
  self.reloadList = loadList;

  loadSettings();
  loadList().then(() => {
    if (!loc.ticketId && self.tickets[0] && matchMedia("(min-width: 761px)").matches) navigate(ticketHref(self.tickets[0].id), { replace: true });
  });
  self.select(loc.ticketId);
  return self;
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";

function shortcutsHelp() {
  const groups = [
    ["Move", [["j", "k"], "Next / previous ticket"], [["/"], "Search"], [["x"], "Select ticket"], [["Esc"], "Clear selection"], [["c"], "New email"]],
    ["Ticket", [["r"], "Reply"], [["n"], "Internal note"], [["f"], "Forward"], [["e"], "Close"], [[ALT, "C"], "Close"], [[ALT, "R"], "Reopen"], [[ALT, "I"], "Mark in progress"], [[ALT, "M"], "Mark as spam"]],
    ["Organize", [["a"], "Assign…"], [["m"], "Assign to me"], [["s"], "Snooze…"], [["t"], "Tags…"], [["p"], "Priority…"]],
    ["Composer", [[MOD, "↵"], "Send · mark in progress"], [[MOD, "⇧", "↵"], "Send & close"], [[ALT, "⇧", "↵"], "Send · mark in progress"], [[MOD, "5"], "Discount code"]],
  ];
  modal("Keyboard shortcuts", h("div", { class: "shortcuts" }, groups.map(([title, ...items]) => h("div", {},
    h("h3", {}, title), items.map(([keys, label]) => h("div", { class: "sc" }, h("span", {}, label), h("span", {}, keys.map((k) => h("kbd", {}, k)))))))), { width: 640 });
}
