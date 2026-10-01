// Ticket vocabulary + the pickers shared by the list, the ticket view and bulk actions.
import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, icon, popover, closePopover, menuList, menuKeys } from "./ui.js";

export const STATUS = {
  open: { label: "Open", icon: "inbox" },
  in_progress: { label: "In progress", icon: "clock" },
  snoozed: { label: "Snoozed", icon: "moon" },
  closed: { label: "Closed", icon: "check" },
  archived: { label: "Archived", icon: "archive" },
  spam: { label: "Spam", icon: "spam" },
  deleted: { label: "Trash", icon: "trash" },
};
export const statusLabel = (s) => STATUS[s]?.label ?? s;
export const statusBadge = (s, extra = "") => h("span", { class: `badge st-${s}${extra}` }, statusLabel(s));

export const PRIORITY = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
export const priorityChip = (p) => (p && p !== "normal" ? h("span", { class: `prio p-${p}`, title: `${PRIORITY[p]} priority` }, icon("flag"), PRIORITY[p]) : null);

const at = (d, hour) => { const x = new Date(d); x.setHours(hour, 0, 0, 0); return x; };
export function snoozeOptions() {
  const now = new Date();
  const tomorrow = at(new Date(now.getTime() + 86400_000), 9);
  const monday = at(new Date(now.getTime() + (((8 - now.getDay()) % 7) || 7) * 86400_000), 9);
  return [
    ["Later today", new Date(now.getTime() + 3 * 3600_000)],
    ["Tomorrow morning", tomorrow],
    ["Next Monday", monday],
    ["In one week", at(new Date(now.getTime() + 7 * 86400_000), 9)],
  ];
}
export const whenLabel = (d) => new Date(d).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Snooze presets + a custom date/time. Calls back with an ISO string. */
export function snoozeMenu(anchor, onPick) {
  const custom = h("input", { class: "input", type: "datetime-local", "aria-label": "Snooze until" });
  const go = h("button", { class: "btn sm dark" }, "Snooze");
  go.onclick = () => {
    if (!custom.value) return custom.focus();
    closePopover();
    onPick(new Date(custom.value).toISOString());
  };
  popover(anchor, h("div", {},
    menuList([{ heading: "Snooze until" }, ...snoozeOptions().map(([label, d]) => ({ label, hint: whenLabel(d).replace(/^\w+, /, ""), run: () => onPick(d.toISOString()) }))]),
    h("hr"),
    h("div", { class: "pop-pad row", style: { gap: "6px", flexWrap: "nowrap" } }, custom, go)), { width: 300 });
}

export function statusMenu(anchor, current, onPick, { snooze = true } = {}) {
  const items = Object.entries(STATUS)
    .filter(([s]) => s !== "snoozed")
    .map(([s, v]) => ({ label: v.label, icon: v.icon, active: s === current, danger: s === "deleted" || s === "spam", run: () => onPick(s) }));
  if (snooze) items.splice(2, 0, { label: "Snooze…", icon: "moon", run: () => setTimeout(() => snoozeMenu(anchor, (until) => onPick("snoozed", until)), 0) });
  popover(anchor, menuList(items), { width: 220 });
}

export function priorityMenu(anchor, current, onPick) {
  popover(anchor, menuList([
    ...Object.entries(PRIORITY).map(([p, label]) => ({ label, icon: "flag", active: p === current, run: () => onPick(p) })),
    { label: "No priority", active: !current, run: () => onPick(null) },
  ]), { width: 200 });
}

export function assignMenu(anchor, currentId, onPick) {
  const filter = h("input", { class: "input", placeholder: "Assign to…", "aria-label": "Find a teammate" });
  const list = h("div");
  const draw = () => {
    const q = filter.value.toLowerCase();
    mount(list, menuList([
      { label: "Assign to me", icon: "user", active: currentId === state.me.id, run: () => onPick(state.me.id) },
      ...state.agents.filter((a) => a.id !== state.me.id && a.name.toLowerCase().includes(q)).map((a) => ({ label: a.name, active: a.id === currentId, run: () => onPick(a.id) })),
      "-",
      { label: "Unassign", disabled: currentId === null, run: () => onPick(null) },
    ]));
  };
  filter.oninput = draw;
  filter.onkeydown = (e) => { if (e.key === "Enter") list.querySelector("button:not([disabled])")?.click(); if (e.key === "ArrowDown") { list.querySelector("button")?.focus(); e.preventDefault(); } };
  draw();
  popover(anchor, h("div", {}, h("div", { class: "pop-pad" }, filter), list), { width: 240 });
}

let tagCache = null;
export async function loadTags(force = false) {
  if (!tagCache || force) tagCache = (await api("/tags")).tags;
  return tagCache;
}

/** Tag picker: checkboxes grouped by tag group, type to filter or create. */
export async function tagMenu(anchor, current, onChange, { mode = "set" } = {}) {
  const tags = await loadTags();
  const chosen = new Set(current.map((t) => t.toLowerCase()));
  const filter = h("input", { class: "input", placeholder: mode === "remove" ? "Remove tag…" : "Find or create a tag…", "aria-label": "Tags" });
  const list = h("div", { class: "pop-list tag-list" });
  const toggle = (name) => {
    if (mode !== "set") { closePopover(); return onChange(name); }
    const k = name.toLowerCase();
    if (chosen.has(k)) {
      chosen.delete(k);
      current = current.filter((t) => t.toLowerCase() !== k);
    } else {
      chosen.add(k);
      current = [...current, name];
    }
    onChange(current);
    draw();
  };
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const pool = mode === "remove" ? current.map((name) => ({ name, group_name: "On selected" })) : tags;
    const matches = pool.filter((t) => t.name.toLowerCase().includes(q));
    const groups = {};
    for (const t of matches) (groups[t.group_name] ??= []).push(t);
    const exact = pool.some((t) => t.name.toLowerCase() === q);
    mount(list,
      Object.entries(groups).map(([g, ts]) => [h("div", { class: "pop-head" }, g), ts.map((t) =>
        h("button", { class: chosen.has(t.name.toLowerCase()) && mode === "set" ? "on" : "", onclick: () => toggle(t.name) },
          h("span", { class: "tick" }, icon("check")), h("span", {}, t.name)))]),
      q && !exact && mode !== "remove" ? h("button", { onclick: () => { tagCache = null; toggle(filter.value.trim()); filter.value = ""; draw(); } }, icon("plus"), h("span", {}, `Create “${filter.value.trim()}”`)) : null,
      !matches.length && (!q || mode === "remove") ? h("div", { class: "muted small pop-pad" }, "No tags") : null);
  };
  filter.oninput = draw;
  filter.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); list.querySelector("button")?.click(); }
    if (e.key === "ArrowDown") { list.querySelector("button")?.focus(); e.preventDefault(); }
  };
  menuKeys(list);
  draw();
  popover(anchor, h("div", {}, h("div", { class: "pop-pad" }, filter), list), { width: 280 });
}

export const tagChips = (tags, max = 3) => {
  if (!tags?.length) return null;
  const shown = tags.slice(0, max);
  return [shown.map((t) => h("span", { class: "tag-chip" }, t)), tags.length > max ? h("span", { class: "tag-chip more" }, `+${tags.length - max}`) : null];
};
