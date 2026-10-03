// Settings → Support: behavior, macros (variables + automations), tags, views, rules, knowledge.
import { api } from "./api.js";
import { state, refreshViews } from "./app.js";
import { h, mount, toast, busy, icon, growInput, relTime, skeletonRows, modal } from "./ui.js";
import { STATUS, PRIORITY } from "./common.js";
import { describeAction, settingsCache } from "./composer.js";

function card(id, title, desc, ...children) {
  return h("section", { class: "card", id }, h("h2", {}, title), desc ? h("p", { class: "muted" }, desc) : null, ...children);
}
function saveBtn(fn, label = "Save") {
  const b = h("button", { class: "btn save-btn" }, label);
  b.onclick = busy(b, async () => { await fn(); b.classList.remove("primary"); toast("Saved"); });
  return b;
}

/** Minimal CSV parser (quoted fields, commas and newlines inside quotes). */
export function parseCsv(text) {
  text = text.replace(/^\ufeff/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const keys = head.map((x) => x.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
const pick = (row, ...names) => {
  for (const n of names) for (const k of Object.keys(row)) if (k === n || k.includes(n)) if (row[k]) return row[k];
  return "";
};
const readFile = (accept) => new Promise((res) => {
  const i = h("input", { type: "file", accept, hidden: true });
  i.onchange = async () => res(i.files[0] ? await i.files[0].text() : null);
  document.body.append(i);
  i.click();
  setTimeout(() => i.remove(), 60000);
});

// ---------------------------------------------------------------- Behavior

export function supportBehavior(s) {
  const sup = { ...s.support };
  const sel = (key, options) => {
    const el = h("select", { class: "input" }, options.map(([v, l]) => h("option", { value: v, selected: String(sup[key]) === String(v) }, l)));
    el.onchange = () => (sup[key] = el.value);
    return el;
  };
  const chk = (key, label) => {
    const c = h("input", { type: "checkbox", checked: !!sup[key] });
    c.onchange = () => (sup[key] = c.checked);
    return h("label", { class: "check" }, c, label);
  };
  const excl = h("textarea", { class: "input", rows: 2, placeholder: "One per line: someone@example.com or @example.com" });
  excl.value = (sup.mergeExclusions || []).join("\n");
  return card("support", "Ticket handling", null,
    h("div", { class: "stack" },
      h("div", { class: "grid2" },
        h("label", { class: "field" }, "New tickets are assigned", sel("assignment", [["manual", "Manually"], ["round_robin", "Round robin (take turns)"], ["balanced", "Balanced (fewest open tickets)"]])),
        h("label", { class: "field" }, "After closing or sending & closing", sel("afterClose", [["next", "Open the next ticket"], ["list", "Go back to the list"], ["stay", "Stay on the ticket"]])),
        h("label", { class: "field" }, "Undo send window", sel("undoSendSeconds", [[0, "Off"], [5, "5 seconds"], [10, "10 seconds"], [20, "20 seconds"]]))),
      chk("autoMerge", "Merge a customer's new email into their open ticket from the last 24 hours"),
      h("label", { class: "field" }, "Never auto-merge mail from", excl),
      chk("closeOnGmailArchive", "Close the ticket when its thread is archived in Gmail"),
      chk("aiAutoInsights", "Write AI insights (summary, mood, type) for every new customer message — about 1¢ each"),
      h("div", {}, saveBtn(async () => {
        sup.mergeExclusions = excl.value.split("\n");
        await api("/settings", { method: "PUT", body: { support: sup } });
        settingsCache.support = null;
      }))));
}

// ---------------------------------------------------------------- Macros

const MACRO_ACTIONS = [["add_tags", "Add tags"], ["set_status", "Set status"], ["set_priority", "Set priority"], ["set_subject", "Change subject"], ["add_note", "Add internal note"]];

export function macrosCard(macros, variables, reload) {
  const list = h("div", { class: "stack" });
  const search = h("input", { class: "input", type: "search", placeholder: `Search ${macros.length} macros…`, "aria-label": "Search macros" });
  const editor = (m = { name: "", body: "", actions: [] }, open = false) => {
    const actions = m.actions.map((a) => ({ ...a }));
    const name = h("input", { class: "input", value: m.name, placeholder: "Name, e.g. Where is my order" });
    const body = h("textarea", { class: "input", rows: 6, placeholder: "Hi {{customer.first_name}}, …" });
    body.value = m.body;
    const varSel = h("select", { class: "input sm", style: { width: "auto" }, "aria-label": "Insert variable" },
      h("option", { value: "" }, "Insert variable…"), variables.map(([k, l]) => h("option", { value: k }, l)));
    varSel.onchange = () => {
      const v = `{{${varSel.value}}}`;
      const at = body.selectionStart ?? body.value.length;
      body.value = body.value.slice(0, at) + v + body.value.slice(body.selectionEnd ?? at);
      body.focus();
      body.selectionStart = body.selectionEnd = at + v.length;
      varSel.value = "";
      body.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const actEl = h("div", { class: "stack", style: { gap: "6px" } });
    const drawActs = () => mount(actEl, actions.map((a, i) => {
      const type = h("select", { class: "input" }, MACRO_ACTIONS.map(([v, l]) => h("option", { value: v, selected: a.type === v }, l)));
      let value;
      if (a.type === "set_status") value = h("select", { class: "input" }, Object.entries(STATUS).filter(([k]) => k !== "snoozed").map(([k, v]) => h("option", { value: k, selected: a.value === k }, v.label)));
      else if (a.type === "set_priority") value = h("select", { class: "input" }, Object.entries(PRIORITY).map(([k, v]) => h("option", { value: k, selected: a.value === k }, v)));
      else value = growInput({ value: a.value, placeholder: a.type === "add_tags" ? "Comma-separated tags" : "" });
      if (!a.value && value.tagName === "SELECT") a.value = value.value;
      type.onchange = () => { a.type = type.value; a.value = ""; drawActs(); };
      value.oninput = value.onchange = () => (a.value = value.value);
      return h("div", { class: "rule-line" }, h("span", { class: "rule-word" }, i ? "and" : "On send"), type, value, h("span"),
        h("button", { class: "btn sm ghost icon-only", "aria-label": "Remove", onclick: () => { actions.splice(i, 1); drawActs(); } }, icon("x")));
    }));
    drawActs();
    const save = saveBtn(async () => {
      const payload = { name: name.value, body: body.value, actions: actions.filter((a) => a.value) };
      if (m.id) await api(`/macros/${m.id}`, { method: "PUT", body: payload });
      else await api("/macros", { method: "POST", body: payload });
      reload();
    });
    const del = m.id ? h("button", { class: "btn ghost danger" }, "Delete") : null;
    if (del) del.onclick = busy(del, async () => {
      if (!confirm(`Delete “${m.name}”?`)) return;
      await api(`/macros/${m.id}`, { method: "DELETE" });
      reload();
    });
    const details = h("details", { class: "macro-row macro-item", open, "data-search": (m.name + " " + m.body).toLowerCase() },
      h("summary", {}, h("b", {}, m.name || "New macro"), m.actions.length ? h("span", { class: "small muted" }, icon("bolt"), m.actions.map(describeAction).join(" · ")) : null, m.uses ? h("span", { class: "small muted", style: { marginLeft: "auto" } }, `used ${m.uses}×`) : null),
      h("div", { class: "stack", style: { paddingTop: "10px" } }, name, body, h("div", { class: "row" }, varSel),
        h("div", { class: "sub-label" }, "Automations"), actEl,
        h("div", {}, h("button", { class: "btn sm ghost", onclick: () => { actions.push({ type: "add_tags", value: "" }); drawActs(); } }, icon("plus"), "Automation")),
        h("div", { class: "row" }, save, del)));
    return details;
  };
  macros.forEach((m) => list.append(editor(m)));
  search.oninput = () => {
    const q = search.value.toLowerCase();
    list.querySelectorAll(".macro-item").forEach((d) => (d.hidden = q && !d.dataset.search.includes(q)));
  };
  const addBtn = h("button", { class: "btn" }, icon("plus"), "New macro");
  addBtn.onclick = () => list.prepend(editor(undefined, true));
  const importBtn = h("button", { class: "btn ghost" }, "Import CSV");
  importBtn.onclick = busy(importBtn, async () => {
    const text = await readFile(".csv,text/csv");
    if (!text) return;
    const rows = parseCsv(text).map((r) => ({
      name: pick(r, "name", "title"),
      body: pick(r, "body", "content", "message", "text", "reply"),
      actions: pick(r, "tags", "tag") ? [{ type: "add_tags", value: pick(r, "tags", "tag") }] : [],
    })).filter((r) => r.name && r.body);
    if (!rows.length) throw new Error("No macros found — the CSV needs a name/title column and a body/content column.");
    const res = await api("/macros/import", { method: "POST", body: { macros: rows } });
    toast(`Imported: ${res.added} new, ${res.updated} updated`);
    reload();
  });
  return card("macros", "Macros",
    "Saved replies with variables like {{customer.first_name}} or {{order.tracking_url}} (filled in from Shopify), plus automations that run when the reply is sent.",
    h("div", { class: "row", style: { marginBottom: "10px" } }, search, addBtn, state.me.role === "admin" ? importBtn : null), list);
}

// ---------------------------------------------------------------- Tags

export function tagsCard(tags, reload) {
  const groups = {};
  for (const t of tags) (groups[t.group_name] ??= []).push(t);
  const name = h("input", { class: "input", placeholder: "New tag" });
  const group = h("input", { class: "input", placeholder: "Group (e.g. General)", list: "tag-groups" });
  const add = h("button", { class: "btn save-btn" }, "Add tag");
  add.onclick = busy(add, async () => {
    if (!name.value.trim()) return;
    await api("/tags", { method: "POST", body: { name: name.value.trim(), group_name: group.value.trim() || "General" } });
    reload();
  });
  const rowFor = (t) => {
    const rename = h("button", { class: "btn sm ghost" }, "Edit");
    rename.onclick = busy(rename, async () => {
      const n = prompt("Tag name (renaming updates every ticket that has it)", t.name);
      if (n === null) return;
      const g = prompt("Group", t.group_name);
      if (g === null) return;
      await api(`/tags/${t.id}`, { method: "PUT", body: { name: n.trim(), group_name: g.trim() } });
      reload();
    });
    const del = h("button", { class: "btn sm ghost danger" }, "Delete");
    del.onclick = busy(del, async () => {
      if (!confirm(`Delete “${t.name}”? It is removed from ${t.uses} ticket${t.uses === 1 ? "" : "s"}.`)) return;
      await api(`/tags/${t.id}`, { method: "DELETE" });
      reload();
    });
    return h("tr", {}, h("td", {}, h("span", { class: "tag-chip" }, t.name)), h("td", { class: "num muted" }, `${t.uses} ticket${t.uses === 1 ? "" : "s"}`),
      h("td", { style: { textAlign: "right", whiteSpace: "nowrap" } }, state.me.role === "admin" ? [rename, del] : null));
  };
  return card("tags", "Tags", "Tags group tickets for views, rules and reports. Type a new tag in any ticket to create it.",
    Object.entries(groups).map(([g, ts]) => [h("h3", { class: "section" }, g), h("table", { class: "tbl" }, h("tbody", {}, ts.map(rowFor)))]),
    h("datalist", { id: "tag-groups" }, Object.keys(groups).map((g) => h("option", { value: g }))),
    h("div", { class: "grid3", style: { marginTop: "14px", gridTemplateColumns: "1.5fr 1.5fr auto" } }, name, group, add));
}

// ---------------------------------------------------------------- Views

export function viewsCard(views, tags, reload) {
  const list = h("div", { class: "stack" });
  const editor = (v = { name: "", folder: "", filters: { status: "active" } }, open = false) => {
    const f = { ...v.filters };
    const name = h("input", { class: "input", value: v.name, placeholder: "View name" });
    const folder = h("input", { class: "input", value: v.folder || "", placeholder: "Folder (optional)" });
    const status = h("select", { class: "input" }, [["active", "Open + in progress"], ["any", "Any status"], ...Object.entries(STATUS).map(([k, s]) => [k, s.label])].map(([k, l]) => h("option", { value: k, selected: f.status === k }, l)));
    const tagSel = h("select", { class: "input", multiple: true, size: 5, "aria-label": "Tags (any of)" }, tags.map((t) => h("option", { value: t.name, selected: (f.tags_any || []).includes(t.name) }, t.name)));
    const assignee = h("select", { class: "input" }, [["", "Anyone"], ["me", "Me (whoever is looking)"], ["none", "Unassigned"], ...state.agents.map((a) => [String(a.id), a.name])].map(([k, l]) => h("option", { value: k, selected: (f.assignee || "") === k }, l)));
    const prio = h("select", { class: "input" }, [["", "Any priority"], ...Object.entries(PRIORITY), ["none", "No priority"]].map(([k, l]) => h("option", { value: k, selected: (f.priority || "") === k }, l)));
    const q = h("input", { class: "input", value: f.q || "", placeholder: "Text contains (optional)" });
    const save = saveBtn(async () => {
      const filters = { status: status.value, tags_any: [...tagSel.selectedOptions].map((o) => o.value), assignee: assignee.value || undefined, priority: prio.value || undefined, q: q.value.trim() || undefined };
      const body = { name: name.value, folder: folder.value, filters };
      if (v.id) await api(`/views/${v.id}`, { method: "PUT", body });
      else await api("/views", { method: "POST", body });
      await refreshViews();
      reload();
    });
    const del = v.id ? h("button", { class: "btn ghost danger" }, "Delete") : null;
    if (del) del.onclick = busy(del, async () => {
      if (!confirm(`Delete the view “${v.name}”?`)) return;
      await api(`/views/${v.id}`, { method: "DELETE" });
      await refreshViews();
      reload();
    });
    return h("details", { class: "macro-row", open },
      h("summary", {}, h("b", {}, v.name || "New view"), v.folder ? h("span", { class: "small muted" }, icon("folder"), v.folder) : null),
      h("div", { class: "stack", style: { paddingTop: "10px" } },
        h("div", { class: "grid2" }, h("label", { class: "field" }, "Name", name), h("label", { class: "field" }, "Folder", folder)),
        h("div", { class: "grid2" },
          h("label", { class: "field" }, "Status", status),
          h("label", { class: "field" }, "Assigned to", assignee),
          h("label", { class: "field" }, "Priority", prio),
          h("label", { class: "field" }, "Search text", q)),
        h("label", { class: "field" }, "Has any of these tags (Ctrl/⌘-click for several)", tagSel),
        h("div", { class: "row" }, save, del)));
  };
  views.forEach((v) => list.append(editor(v)));
  const add = h("button", { class: "btn" }, icon("plus"), "New view");
  add.onclick = () => list.prepend(editor(undefined, true));
  return card("views", "Views", "Saved filters in the sidebar, with live counts. Group them into folders.", h("div", { style: { marginBottom: "10px" } }, add), list);
}

// ---------------------------------------------------------------- Support rules

const OPS = { contains: "contains", not_contains: "doesn't contain", is: "is", is_not: "is not", gt: "more than", lt: "fewer than", eq: "exactly" };

export function supportRulesCard(data, macros, tags, reload) {
  const rules = data.rules.map((r) => ({ ...r, conditions: r.conditions.map((c) => ({ ...c })), actions: r.actions.map((a) => ({ ...a })) }));
  const listEl = h("div");
  const fieldKeys = Object.keys(data.fields);
  const valueInput = (obj, kind) => {
    let el;
    if (kind === "status") el = h("select", { class: "input" }, Object.entries(STATUS).map(([k, s]) => h("option", { value: k, selected: obj.value === k }, s.label)));
    else if (kind === "priority") el = h("select", { class: "input" }, Object.entries(PRIORITY).map(([k, l]) => h("option", { value: k, selected: obj.value === k }, l)));
    else if (kind === "assigned") el = h("select", { class: "input" }, [["yes", "yes"], ["no", "no"]].map(([k, l]) => h("option", { value: k, selected: obj.value === k }, l)));
    else if (kind === "assign") el = h("select", { class: "input" }, [["round_robin", "Round robin"], ["balanced", "Balanced"], ["nobody", "Nobody"], ...state.agents.map((a) => [String(a.id), a.name])].map(([k, l]) => h("option", { value: k, selected: obj.value === k }, l)));
    else if (kind === "auto_reply") el = h("select", { class: "input" }, h("option", { value: "" }, "Choose a macro…"), macros.map((m) => h("option", { value: String(m.id), selected: obj.value === String(m.id) }, m.name)));
    else if (kind === "message_count") el = h("input", { class: "input", value: obj.value, placeholder: "Number", inputmode: "numeric" });
    else el = growInput({ value: obj.value, placeholder: kind === "has_tag" || kind === "tag" ? "Tag names, comma-separated" : "Words or phrases, comma-separated" });
    if (el.tagName === "SELECT" && !obj.value) obj.value = el.value;
    el.oninput = el.onchange = () => (obj.value = el.value);
    return el;
  };
  const condRow = (rule, c, i) => {
    const field = h("select", { class: "input" }, fieldKeys.map((k) => h("option", { value: k, selected: c.field === k }, data.fields[k].label)));
    const op = h("select", { class: "input" }, data.fields[c.field].ops.map((o) => h("option", { value: o, selected: c.op === o }, OPS[o])));
    field.onchange = () => { c.field = field.value; c.op = data.fields[c.field].ops[0]; c.value = ""; draw(); };
    op.onchange = () => (c.op = op.value);
    return h("div", { class: "rule-line" }, h("span", { class: "rule-word" }, i === 0 ? "If" : rule.match === "any" ? "or" : "and"), field, op, valueInput(c, c.field),
      h("button", { class: "btn sm ghost icon-only", "aria-label": "Remove condition", onclick: () => { rule.conditions.splice(i, 1); draw(); } }, icon("x")));
  };
  const ACTION_LABELS = { set_status: "Set status", set_priority: "Set priority", add_tag: "Add tag", remove_tag: "Remove tag", assign: "Assign to", auto_reply: "Auto-reply with macro" };
  const actionRow = (rule, a, i) => {
    const type = h("select", { class: "input" }, data.actions.map((t) => h("option", { value: t, selected: a.type === t }, ACTION_LABELS[t])));
    type.onchange = () => { a.type = type.value; a.value = ""; draw(); };
    const kind = { set_status: "status", set_priority: "priority", add_tag: "tag", remove_tag: "tag", assign: "assign", auto_reply: "auto_reply" }[a.type];
    return h("div", { class: "rule-line" }, h("span", { class: "rule-word" }, i === 0 ? "Then" : "and"), type, valueInput(a, kind), h("span"),
      h("button", { class: "btn sm ghost icon-only", "aria-label": "Remove action", onclick: () => { rule.actions.splice(i, 1); draw(); } }, icon("x")));
  };
  const draw = () => mount(listEl, Object.entries(data.triggers).map(([trig, label]) => {
    const group = rules.filter((r) => r.trigger === trig);
    return h("div", { class: "rule-group" },
      h("h3", { class: "section" }, label, h("span", { class: "small muted" }, ` · ${group.length} rule${group.length === 1 ? "" : "s"}`)),
      group.map((r) => {
        const idx = rules.indexOf(r);
        const name = h("input", { class: "input", value: r.name, placeholder: "Rule name", style: { fontWeight: 700 } });
        name.oninput = () => (r.name = name.value);
        const on = h("input", { type: "checkbox", checked: r.enabled });
        on.onchange = () => (r.enabled = on.checked);
        const match = h("select", { class: "input sm", style: { width: "auto" } }, h("option", { value: "all", selected: r.match !== "any" }, "Match all"), h("option", { value: "any", selected: r.match === "any" }, "Match any"));
        match.onchange = () => { r.match = match.value; draw(); };
        const move = (d) => {
          const sib = group[group.indexOf(r) + d];
          if (!sib) return;
          const j = rules.indexOf(sib);
          [rules[idx], rules[j]] = [rules[j], rules[idx]];
          draw();
        };
        return h("div", { class: "macro-row" + (r.enabled ? "" : " off") },
          h("div", { class: "rule-head" }, name, match,
            h("label", { class: "check", style: { whiteSpace: "nowrap" } }, on, "On"),
            h("button", { class: "btn sm ghost", title: "Run earlier", onclick: () => move(-1) }, "↑"),
            h("button", { class: "btn sm ghost danger", onclick: () => { rules.splice(idx, 1); draw(); } }, "Delete")),
          r.conditions.map((c, i) => condRow(r, c, i)),
          h("div", {}, h("button", { class: "btn sm ghost", onclick: () => { r.conditions.push({ field: "subject", op: "contains", value: "" }); draw(); } }, icon("plus"), "Condition")),
          r.actions.map((a, i) => actionRow(r, a, i)),
          h("div", {}, h("button", { class: "btn sm ghost", onclick: () => { r.actions.push({ type: "add_tag", value: "" }); draw(); } }, icon("plus"), "Action")));
      }),
      h("button", { class: "btn sm", onclick: () => { rules.push({ name: "", trigger: trig, enabled: true, match: "all", conditions: [{ field: "subject", op: "contains", value: "" }], actions: [{ type: "add_tag", value: "" }] }); draw(); } }, icon("plus"), "New rule"));
  }));
  draw();
  const save = saveBtn(async () => {
    await api("/support-rules", { method: "PUT", body: { rules } });
    reload();
  }, "Save rules");
  return card("rules", "Support rules", "Run automatically, top to bottom, at each moment below. Every run is logged in the ticket's Activity tab. An auto-reply is sent at most once every 6 hours per ticket.",
    h("datalist", { id: "rule-tags" }, tags.map((t) => h("option", { value: t.name }))),
    listEl, h("div", { class: "row", style: { marginTop: "12px" } }, save));
}

// ---------------------------------------------------------------- Knowledge

const KTYPES = { policy: "Policy", faq: "FAQ", product: "Product", shipping: "Shipping", other: "Other" };

export function knowledgeCard(items, reload) {
  const list = h("div", { class: "stack" });
  const editor = (k = { name: "", content: "", type: "policy", status: "active" }, open = false) => {
    const name = h("input", { class: "input", value: k.name, placeholder: "Title, e.g. Return policy" });
    const fromSite = !!k.source;
    const content = h("textarea", { class: "input", rows: 6, placeholder: "What the AI should know…", readonly: fromSite });
    content.value = k.content;
    const type = h("select", { class: "input" }, Object.entries(KTYPES).map(([v, l]) => h("option", { value: v, selected: k.type === v }, l)));
    const active = h("input", { type: "checkbox", checked: k.status !== "inactive" });
    const save = saveBtn(async () => {
      const body = { name: name.value, content: content.value, type: type.value, status: active.checked ? "active" : "inactive" };
      if (k.id) await api(`/knowledge/${k.id}`, { method: "PUT", body });
      else await api("/knowledge", { method: "POST", body });
      reload();
    });
    const del = k.id ? h("button", { class: "btn ghost danger" }, "Delete") : null;
    if (del) del.onclick = busy(del, async () => {
      if (!confirm(`Delete “${k.name}”?`)) return;
      await api(`/knowledge/${k.id}`, { method: "DELETE" });
      reload();
    });
    return h("details", { class: "macro-row" + (k.status === "inactive" ? " off" : ""), open },
      h("summary", {}, h("b", {}, k.name || "New entry"), h("span", { class: "badge plain" }, KTYPES[k.type] ?? k.type),
        fromSite ? h("span", { class: "badge good plain", title: k.synced_at ? `Updated from the website ${relTime(k.synced_at)}` : "" }, "From website") : null, k.status === "inactive" ? h("span", { class: "small muted" }, "off") : null,
        k.uses ? h("span", { class: "small muted", style: { marginLeft: "auto" } }, `used in ${k.uses} draft${k.uses === 1 ? "" : "s"}`) : null),
      h("div", { class: "stack", style: { paddingTop: "10px" } }, h("div", { class: "grid2", style: { gridTemplateColumns: "2fr 1fr" } }, name, type),
        fromSite ? h("div", { class: "small muted" }, "Copied from ", h("a", { href: k.source_url, target: "_blank", rel: "noopener" }, k.source_url), ` and refreshed daily${k.synced_at ? ` (last ${relTime(k.synced_at)})` : ""}. Edit it on the website; delete it here to stop using it.`) : null,
        content,
        h("label", { class: "check" }, active, "Use in AI drafts"), h("div", { class: "row" }, save, del)));
  };
  items.forEach((k) => list.append(editor(k)));
  const add = h("button", { class: "btn" }, icon("plus"), "New entry");
  add.onclick = () => list.prepend(editor(undefined, true));
  const importBtn = h("button", { class: "btn ghost" }, "Import CSV");
  importBtn.onclick = busy(importBtn, async () => {
    const text = await readFile(".csv,text/csv");
    if (!text) return;
    const entries = parseCsv(text).map((r) => ({
      name: pick(r, "name", "title", "question"),
      content: pick(r, "content", "answer", "body", "text", "description"),
      type: pick(r, "type", "category"),
      status: pick(r, "status"),
    })).filter((e) => e.name && e.content);
    if (!entries.length) throw new Error("No entries found — the CSV needs a name/title column and a content/answer column.");
    const r = await api("/knowledge/import", { method: "POST", body: { entries } });
    toast(`Imported ${r.added} entries`);
    reload();
  });
  const isAdmin = state.me.role === "admin";
  const site = h("button", { class: "btn" }, icon("link"), "Add from your website");
  site.onclick = () => siteDialog(reload);
  const refresh = h("button", { class: "btn ghost" }, icon("refresh"), "Refresh from website");
  refresh.onclick = busy(refresh, async () => {
    const r = await api("/knowledge/site/refresh", { method: "POST" });
    toast(r.errors.length ? `Refreshed ${r.refreshed}; ${r.errors.length} couldn't be read: ${r.errors[0]}` : `Refreshed ${r.refreshed} from the website`, !!r.errors.length);
    reload();
  });
  return card("knowledge", "AI knowledge", "Policies, FAQs and product facts the AI uses for the website chat and reply drafts. Add pages straight from your website (they stay in sync, checked daily), upload a CSV, or write entries here. Only entries that are switched on are used.",
    h("div", { class: "row", style: { marginBottom: "10px", flexWrap: "wrap" } }, isAdmin ? site : null, add, isAdmin ? importBtn : null, isAdmin && items.some((k) => k.source) ? refresh : null), list);
}

/** Pick store pages and policies (or paste any link) to use as AI knowledge. */
async function siteDialog(reload) {
  const body = h("div", { class: "stack" }, skeletonRows(4));
  const { close } = modal("Add from your website", body, { width: 620 });
  let data = { policies: [], pages: [] };
  let problem = null;
  try {
    data = await api("/knowledge/site");
  } catch (e) {
    // Links still work without Shopify
    problem = /access denied|scope/i.test(e.message)
      ? "To list your store's pages and policies, the Shopify app needs read_content and read_legal_policies (Shopify admin → Apps → your app → Configuration). You can still add pages by link below."
      : `Couldn't list your store's pages (${e.message}). You can still add pages by link below.`;
  }
  const picked = new Set();
  const row = (x) => {
    const c = h("input", { type: "checkbox", checked: x.added, disabled: x.added });
    c.onchange = () => (c.checked ? picked.add(x.source) : picked.delete(x.source));
    return h("label", { class: "check site-row" }, c, h("span", {}, h("b", {}, x.title), x.added ? h("span", { class: "small muted" }, " · added") : null,
      h("span", { class: "small muted", style: { display: "block" } }, x.url)));
  };
  const url = h("input", { class: "input", type: "url", placeholder: "https://tufttheworld.com/pages/…  (any public page)" });
  const go = h("button", { class: "btn primary" }, "Add");
  go.onclick = busy(go, async () => {
    if (!picked.size && !url.value.trim()) return toast("Tick a page or paste a link", true);
    const r = await api("/knowledge/site", { method: "POST", body: { sources: [...picked], url: url.value.trim() || undefined } });
    toast(`Added ${r.added} from your website`);
    close();
    reload();
  });
  mount(body,
    h("p", { class: "muted", style: { margin: 0 } }, "The AI reads these and keeps them up to date — change the page on your site and the AI follows within a day."),
    problem ? h("div", { class: "notice" }, problem) : null,
    data.policies.length ? [h("h3", { class: "section" }, "Store policies"), data.policies.map(row)] : null,
    data.pages.length ? [h("h3", { class: "section" }, "Pages"), h("div", { class: "site-list" }, data.pages.map(row))] : null,
    h("label", { class: "field" }, "Or add any page by link", url),
    h("div", { class: "row" }, go));
}
