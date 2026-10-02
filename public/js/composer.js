// Rich-text composer: reply / reply all / forward / internal note, plus the new-email form.
// Macros (with variables + automations), discount codes, AI drafts, attachments, undo send.
import { api } from "./api.js";
import { state, navigate, refreshCounts } from "./app.js";
import { h, mount, icon, toast, busy, spinner, fileSize, popover, closePopover, menuList, modal, actionToast } from "./ui.js";
import { STATUS, statusLabel } from "./common.js";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
export const settingsCache = { support: null, integrations: null };

export async function loadSettings() {
  if (!settingsCache.support) {
    try {
      const s = await api("/settings");
      settingsCache.support = s.support;
      settingsCache.integrations = s.integrations;
    } catch {
      settingsCache.support = { undoSendSeconds: 5, afterClose: "next" };
      settingsCache.integrations = {};
    }
  }
  return settingsCache;
}

function storage(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked */ }
  return null;
}

const textToHtml = (t) => t.split(/\n{2,}/).map((p) => `<p>${p.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/\n/g, "<br>")}</p>`).join("");

/** Keeps only simple formatting from pasted / typed HTML. */
function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const ALLOWED = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "UL", "OL", "LI", "A", "DIV", "SPAN", "BLOCKQUOTE"]);
  const walk = (el) => {
    for (const c of [...el.children]) {
      walk(c);
      if (!ALLOWED.has(c.tagName)) {
        c.replaceWith(...c.childNodes);
        continue;
      }
      for (const a of [...c.attributes]) if (!(c.tagName === "A" && a.name === "href")) c.removeAttribute(a.name);
      if (c.tagName === "A") {
        if (!/^(https?:|mailto:)/i.test(c.getAttribute("href") || "")) c.removeAttribute("href");
        else c.setAttribute("target", "_blank");
      }
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

function editorText(ed) {
  // innerText keeps line breaks the way they look
  return ed.innerText.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function insertHtmlAtCursor(ed, html) {
  ed.focus();
  const sel = getSelection();
  if (!sel.rangeCount || !ed.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  document.execCommand("insertHTML", false, html);
  ed.dispatchEvent(new Event("input"));
}

function readFiles(fileInput, files, render) {
  fileInput.addEventListener("change", async () => {
    for (const file of fileInput.files) {
      if (file.size > 15 * 1024 * 1024) { toast(`${file.name} is too large (15 MB max)`, true); continue; }
      const base64 = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.readAsDataURL(file);
      });
      files.push({ filename: file.name, mimeType: file.type || "application/octet-stream", base64, size: file.size });
    }
    fileInput.value = "";
    render();
  });
}

const parseList = (s) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

/** The formatting toolbar + contenteditable body. */
function richEditor(placeholder) {
  const ed = h("div", { class: "rte", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": placeholder, "data-placeholder": placeholder });
  ed.addEventListener("paste", (e) => {
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    document.execCommand("insertHTML", false, html ? cleanHtml(html) : textToHtml(text));
  });
  const cmd = (name, arg) => () => { ed.focus(); document.execCommand(name, false, arg); ed.dispatchEvent(new Event("input")); };
  const tb = (ic, label, fn) => h("button", { class: "tb", type: "button", title: label, "aria-label": label, onmousedown: (e) => e.preventDefault(), onclick: fn }, icon(ic));
  const link = () => {
    const url = prompt("Link address (https://…)");
    if (url && /^(https?:|mailto:)/i.test(url.trim())) cmd("createLink", url.trim())();
  };
  const toolbar = h("div", { class: "rte-bar", role: "toolbar", "aria-label": "Formatting" },
    tb("bold", `Bold (${MOD}+B)`, cmd("bold")), tb("italic", `Italic (${MOD}+I)`, cmd("italic")), tb("underline", `Underline (${MOD}+U)`, cmd("underline")),
    tb("strike", "Strikethrough", cmd("strikeThrough")), h("span", { class: "sep" }),
    tb("ul", "Bulleted list", cmd("insertUnorderedList")), tb("ol", "Numbered list", cmd("insertOrderedList")),
    tb("link", "Link", link), tb("eraser", "Clear formatting", cmd("removeFormat")));
  return { ed, toolbar };
}

// ---------------------------------------------------------------- Macro picker

export async function pickMacro(ticketId, onAdd) {
  const { macros, variables } = await api("/macros");
  const search = h("input", { class: "input", placeholder: "Search macros…", "aria-label": "Search macros" });
  const list = h("div", { class: "macro-list", role: "listbox" });
  const preview = h("div", { class: "macro-preview" }, h("p", { class: "muted" }, "Pick a macro to preview it with this ticket's details."));
  let current = null;
  let rendered = null;
  const add = h("button", { class: "btn primary", disabled: true }, "Add to message");
  const show = async (m) => {
    current = m;
    list.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.id) === m.id));
    mount(preview, h("div", { class: "loading" }, spinner()));
    add.disabled = true;
    try {
      rendered = ticketId ? await api(`/tickets/${ticketId}/render-macro`, { method: "POST", body: { macro_id: m.id } }) : { text: m.body, actions: m.actions };
    } catch (e) {
      rendered = { text: m.body, actions: m.actions };
    }
    if (current !== m) return;
    add.disabled = false;
    mount(preview,
      h("h3", {}, m.name),
      h("div", { class: "macro-body" }, rendered.text),
      rendered.actions?.length ? h("div", { class: "macro-actions" }, h("div", { class: "sub-label" }, "When sent, this macro will"),
        rendered.actions.map((a) => h("div", { class: "small" }, icon("bolt"), " ", describeAction(a)))) : null);
  };
  const draw = () => {
    const q = search.value.toLowerCase();
    const found = macros.filter((m) => (m.name + " " + m.body).toLowerCase().includes(q)).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
    mount(list, found.length ? found.map((m) => h("button", { "data-id": m.id, role: "option", onclick: () => show(m), ondblclick: () => { show(m).then(() => add.click()); } },
      h("b", {}, m.name), m.actions.length ? h("span", { class: "auto" }, icon("bolt"), m.actions.length) : null)) : h("p", { class: "muted small", style: { padding: "8px" } }, macros.length ? "No matches" : "No macros yet. Add them in Settings → Macros, tags & views."));
  };
  search.oninput = draw;
  search.onkeydown = (e) => { if (e.key === "Enter") list.querySelector("button")?.click(); if (e.key === "ArrowDown") { list.querySelector("button")?.focus(); e.preventDefault(); } };
  list.addEventListener("keydown", (e) => {
    const items = [...list.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    if (e.key === "Enter" && current && document.activeElement?.dataset.id == current.id) add.click();
  });
  draw();
  const dlg = modal("Macros", h("div", { class: "macro-picker" },
    h("div", { class: "macro-left" }, search, list, h("a", { href: "/settings/macros#macros", "data-link": "", class: "small", onclick: () => dlg.close() }, "Manage macros")),
    h("div", { class: "macro-right" }, preview, h("div", { class: "row", style: { justifyContent: "flex-end", marginTop: "auto", paddingTop: "12px" } }, add))), { width: 860 });
  add.onclick = () => {
    if (!current || !rendered) return;
    dlg.close();
    onAdd(current, rendered);
  };
  void variables;
}

export function describeAction(a) {
  if (a.type === "add_tags") return `Add tag${a.value.includes(",") ? "s" : ""} ${a.value}`;
  if (a.type === "set_status") return `Set status to ${statusLabel(a.value)}`;
  if (a.type === "set_subject") return `Change subject to “${a.value}”`;
  if (a.type === "add_note") return `Add internal note “${a.value.slice(0, 60)}${a.value.length > 60 ? "…" : ""}”`;
  if (a.type === "set_priority") return `Set priority to ${a.value}`;
  return `${a.type} ${a.value}`;
}

// ---------------------------------------------------------------- Discount code

function discountPopover(anchor, ticketId, onCode) {
  const kind = h("select", { class: "input", "aria-label": "Discount type" }, h("option", { value: "percentage" }, "% off"), h("option", { value: "amount" }, "$ off"));
  const value = h("input", { class: "input", type: "number", min: "1", step: "1", value: "10", "aria-label": "Amount" });
  const days = h("input", { class: "input", type: "number", min: "1", value: "30", "aria-label": "Expires after days" });
  const code = h("input", { class: "input", placeholder: "Auto (e.g. TTW-4F2A9C)", "aria-label": "Code" });
  const go = h("button", { class: "btn primary sm" }, "Create code");
  go.onclick = busy(go, async () => {
    const r = await api(`/tickets/${ticketId}/discount`, { method: "POST", body: { kind: kind.value, value: Number(value.value), days: Number(days.value) || undefined, code: code.value.trim() || undefined } });
    closePopover();
    onCode(r.code, kind.value === "amount" ? `$${value.value}` : `${value.value}%`);
    toast(`Discount ${r.code} created in Shopify`);
  });
  popover(anchor, h("div", { class: "pop-pad stack", style: { gap: "10px" } },
    h("b", {}, "Shopify discount code"),
    h("div", { class: "row", style: { flexWrap: "nowrap", gap: "6px" } }, value, kind),
    h("label", { class: "field" }, h("span", {}, "Expires after (days)"), days),
    h("label", { class: "field" }, h("span", {}, "Code"), code),
    h("p", { class: "small muted", style: { margin: 0 } }, "One use, whole order. Needs the write_discounts scope on the Shopify app."),
    go), { width: 280 });
}

// ---------------------------------------------------------------- Send queue (undo)

/** Sends after the undo window. The draft stays saved until the server confirms. */
function queueSend({ path, body, draftKey, label, ticketId, seconds, onSent, onUndo }) {
  const fire = async () => {
    try {
      const r = await api(path, { method: "POST", body });
      if (draftKey) storage(draftKey, null);
      refreshCounts();
      onSent?.(r);
    } catch (e) {
      toast(`Not sent: ${e.message}. Your draft is saved.`, true);
      if (ticketId) navigate(`/tickets/${ticketId}?view=${new URLSearchParams(location.search).get("view") || "open"}`);
    }
  };
  if (!seconds) return fire();
  let undone = false;
  const timer = setTimeout(() => { dismiss(); if (!undone) fire(); }, seconds * 1000);
  const dismiss = actionToast(label, "Undo", () => {
    undone = true;
    clearTimeout(timer);
    onUndo?.();
  }, seconds * 1000 + 400);
}

// ---------------------------------------------------------------- Reply composer

export function buildComposer(inbox, t, data) {
  const cfg = settingsCache;
  const draftKey = `draft2:${t.id}`;
  const saved = storage(draftKey) || {};
  let mode = saved.mode || "reply";
  const files = [];
  let macroIds = saved.macroIds || [];
  let macroActions = saved.macroActions || [];
  const mentions = new Map();

  const lastIn = [...data.messages].reverse().find((m) => m.direction === "in") || data.messages.at(-1);
  const support = (cfg.integrations?.gmail?.email || "").toLowerCase();
  const replyAllCc = () => {
    if (!lastIn) return [];
    const all = [lastIn.from_email, ...lastIn.to_emails.split(/,\s*/), ...lastIn.cc_emails.split(/,\s*/)].map((x) => x.trim().toLowerCase()).filter(Boolean);
    return [...new Set(all)].filter((x) => x !== support && x !== t.customer_email.toLowerCase());
  };

  const { ed, toolbar } = richEditor("Write your reply…");
  if (saved.html) ed.innerHTML = saved.html;
  const toIn = h("input", { class: "rcpt-in", "aria-label": "To" });
  const ccIn = h("input", { class: "rcpt-in", "aria-label": "Cc" });
  const bccIn = h("input", { class: "rcpt-in", "aria-label": "Bcc" });
  const rcptRows = h("div", { class: "rcpt", hidden: true },
    h("label", {}, h("span", {}, "To"), toIn), h("label", {}, h("span", {}, "Cc"), ccIn), h("label", {}, h("span", {}, "Bcc"), bccIn));
  const toSummary = h("button", { class: "to", type: "button", title: "Edit recipients" });
  const fillRecipients = () => {
    if (mode === "forward") { toIn.value = saved.to ?? ""; ccIn.value = ""; }
    else { toIn.value = t.customer_email; ccIn.value = mode === "reply_all" ? replyAllCc().join(", ") : ""; }
    bccIn.value = "";
  };
  const drawSummary = () => {
    if (mode === "note") return mount(toSummary, icon("note"), "Only your team sees notes · type @ to mention");
    const to = parseList(toIn.value);
    const cc = parseList(ccIn.value);
    const bcc = parseList(bccIn.value);
    mount(toSummary, to.length ? `To ${to.join(", ")}` : mode === "forward" ? "Add who to forward to…" : "To —", cc.length ? ` · Cc ${cc.length}` : "", bcc.length ? ` · Bcc ${bcc.length}` : "", h("span", { class: "edit" }, "Edit"));
  };
  toSummary.onclick = () => { rcptRows.hidden = !rcptRows.hidden; if (!rcptRows.hidden) toIn.focus(); };
  [toIn, ccIn, bccIn].forEach((i) => i.addEventListener("input", drawSummary));

  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  const filesEl = h("div", { class: "pending-files" });
  const renderFiles = () => mount(filesEl, files.map((f, i) =>
    h("span", { class: "attachment" }, icon("clip"), f.filename, h("span", { class: "muted" }, fileSize(f.size)),
      h("button", { "aria-label": `Remove ${f.filename}`, onclick: () => { files.splice(i, 1); renderFiles(); } }, icon("x")))));
  readFiles(fileInput, files, renderFiles);

  const autoEl = h("div", { class: "automations" });
  const renderAutos = () => mount(autoEl, macroActions.length ? [h("span", { class: "small muted" }, "On send:"), macroActions.map((a, i) =>
    h("span", { class: "auto-chip" }, icon("bolt"), describeAction(a), h("button", { "aria-label": "Remove", onclick: () => { macroActions.splice(i, 1); renderAutos(); save(); } }, icon("x"))))] : null);

  const save = () => storage(draftKey, ed.textContent.trim() || macroActions.length ? { html: ed.innerHTML, mode, macroIds, macroActions, to: mode === "forward" ? toIn.value : undefined } : null);
  ed.addEventListener("input", () => { save(); mentionCheck(); });

  // Tabs
  const tabs = {
    reply: h("button", { class: "tab", type: "button" }, icon("reply"), "Reply"),
    reply_all: h("button", { class: "tab", type: "button" }, icon("replyAll"), "Reply all"),
    forward: h("button", { class: "tab", type: "button" }, icon("forward"), "Forward"),
    note: h("button", { class: "tab", type: "button" }, icon("note"), "Internal note"),
  };
  const setMode = (m, focus = true) => {
    mode = m;
    for (const [k, b] of Object.entries(tabs)) b.classList.toggle("active", k === m);
    el.classList.toggle("note-mode", m === "note");
    ed.dataset.placeholder = m === "note" ? "Only your team sees notes. Type @ to mention someone…" : m === "forward" ? "Add a message (optional)…" : `Reply to ${t.customer_name?.split(/\s+/)[0] || t.customer_email}…`;
    fillRecipients();
    rcptRows.hidden = m !== "forward";
    drawSummary();
    replyBtns.hidden = m === "note";
    noteBtn.hidden = m !== "note";
    for (const b of [attachBtn, discountBtn, macroBtn]) b.hidden = m === "note";
    save();
    if (focus) ed.focus();
  };
  for (const [k, b] of Object.entries(tabs)) b.onclick = () => setMode(k);

  // @mentions in notes
  const mentionCheck = () => {
    if (mode !== "note") return;
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3) return closeMentionPop();
    const before = node.textContent.slice(0, sel.anchorOffset);
    const m = before.match(/(^|\s)@([\w.-]*)$/);
    if (!m) return closeMentionPop();
    const q = m[2].toLowerCase();
    const found = state.agents.filter((a) => a.name.toLowerCase().includes(q) || a.email.toLowerCase().startsWith(q)).slice(0, 6);
    if (!found.length) return closeMentionPop();
    const caret = sel.getRangeAt(0).getBoundingClientRect();
    const anchor = { getBoundingClientRect: () => caret, contains: () => false, focus: () => ed.focus() };
    mentionOpen = true;
    popover(anchor, menuList(found.map((a) => ({
      label: a.name, hint: a.email.split("@")[0], run: () => {
        const range = document.createRange();
        range.setStart(node, sel.anchorOffset - m[2].length - 1);
        range.setEnd(node, sel.anchorOffset);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, `@${a.name} `);
        mentions.set(a.id, a.name);
        mentionOpen = false;
      },
    }))), { width: 240 });
    ed.focus();
  };
  let mentionOpen = false;
  const closeMentionPop = () => { if (mentionOpen) { closePopover(); mentionOpen = false; } };

  // Toolbar extras
  const macroBtn = h("button", { class: "tb wide", type: "button", title: "Macros (saved replies)" }, icon("bolt"), "Macros");
  macroBtn.onclick = () => pickMacro(t.id, (m, r) => {
    insertHtmlAtCursor(ed, textToHtml(r.text));
    macroIds = [...new Set([...macroIds, m.id])];
    macroActions = [...macroActions, ...(r.actions || [])];
    renderAutos();
    save();
  }).catch((e) => toast(e.message, true));
  const discountBtn = h("button", { class: "tb wide", type: "button", title: `Create a Shopify discount code (${MOD}+5)` }, icon("percent"), "Discount");
  discountBtn.onclick = () => discountPopover(discountBtn, t.id, (code, amount) => insertHtmlAtCursor(ed, `<b>${code}</b>&nbsp;`) || void amount);
  const attachBtn = h("button", { class: "tb wide", type: "button", title: "Attach files", onclick: () => fileInput.click() }, icon("clip"), "Attach");

  // AI draft
  const aiRow = h("div", { class: "ai-row", hidden: true });
  const aiInstr = h("input", { class: "input", placeholder: "Optional: what should the reply do? e.g. offer a replacement" });
  const aiGo = h("button", { class: "btn sm dark" }, "Write draft");
  aiRow.append(aiInstr, aiGo);
  const aiBtn = cfg.integrations?.ai?.connected
    ? h("button", { class: "tb wide", type: "button", title: "Draft a reply with AI (about 1–2¢ per draft)", onclick: () => { aiRow.hidden = !aiRow.hidden; if (!aiRow.hidden) aiInstr.focus(); } }, icon("spark"), "AI")
    : null;
  const runAi = busy(aiGo, async () => {
    aiGo.replaceChildren(spinner(), "Writing…");
    try {
      const { draft } = await api(`/tickets/${t.id}/ai-draft`, { method: "POST", body: { instruction: aiInstr.value.trim() || undefined } });
      if (mode === "note") setMode("reply", false);
      ed.innerHTML = textToHtml(draft);
      save();
      aiRow.hidden = true;
      ed.focus();
      toast("Draft ready — read it over before sending");
    } finally {
      aiGo.replaceChildren("Write draft");
    }
  });
  aiGo.onclick = runAi;
  aiInstr.addEventListener("keydown", (e) => { if (e.key === "Enter") runAi(); });

  // Send buttons
  const sendCloseBtn = h("button", { class: "btn primary", title: `Send, close and open the next ticket (${MOD}+Shift+Enter)` }, icon("send"), "Send & close");
  const sendBtn = h("button", { class: "btn split-main", title: `Send and mark in progress (${MOD}+Enter)` }, "Send");
  const sendMore = h("button", { class: "btn split-more icon-only", "aria-label": "More send options", title: "More send options" }, icon("chevron"));
  sendMore.onclick = () => popover(sendMore, menuList([
    { label: "Send and mark in progress", hint: `${MOD}↵`, run: () => send("in_progress") },
    { label: "Send and keep open", run: () => send("open") },
    { label: "Send and snooze…", icon: "moon", run: () => import("./common.js").then(({ snoozeMenu }) => snoozeMenu(sendMore, (until) => send("snoozed", until))) },
    { label: "Send and close", hint: `${MOD}⇧↵`, run: () => send("closed") },
  ]), { width: 260, align: "right" });
  const replyBtns = h("div", { class: "row send-group", style: { gap: "6px" } }, h("div", { class: "split" }, sendBtn, sendMore), sendCloseBtn);
  const noteBtn = h("button", { class: "btn dark", hidden: true }, "Add note");
  const discardBtn = h("button", { class: "btn ghost sm icon-only", title: "Discard draft", "aria-label": "Discard draft", onclick: () => {
    ed.innerHTML = ""; macroActions = []; macroIds = []; files.length = 0; renderFiles(); renderAutos(); storage(draftKey, null); setMode("reply");
  } }, icon("trash"));

  const send = (status, snoozeUntil) => {
    const text = editorText(ed);
    if (!text && mode !== "forward") { toast("Write a reply first", true); ed.focus(); return; }
    const to = parseList(toIn.value);
    if (!to.length) { toast("Add who to send to", true); rcptRows.hidden = false; toIn.focus(); return; }
    // A macro's "set status" applies when you use plain Send
    const macroStatus = macroActions.find((a) => a.type === "set_status")?.value;
    const finalStatus = status === "in_progress" && macroStatus && STATUS[macroStatus] ? macroStatus : status;
    const body = {
      mode: mode === "note" ? "reply" : mode,
      html: cleanHtml(ed.innerHTML),
      text,
      to,
      cc: parseList(ccIn.value),
      bcc: parseList(bccIn.value),
      status: mode === "forward" && status === "in_progress" ? undefined : finalStatus,
      snooze_until: snoozeUntil,
      attachments: files.map(({ size, ...f }) => f),
      macro_ids: macroIds,
      macro_actions: macroActions.filter((a) => a.type !== "set_status"),
    };
    save();
    const seconds = Number(cfg.support?.undoSendSeconds ?? 5);
    const closing = ["closed", "snoozed", "archived"].includes(body.status);
    const label = mode === "forward" ? "Forwarding…" : closing ? `Sending & ${body.status === "snoozed" ? "snoozing" : "closing"}…` : "Sending…";
    ed.innerHTML = "";
    files.length = 0;
    renderFiles();
    const moveOn = closing || ["open", "mine", "unassigned"].includes(inbox.view);
    const after = cfg.support?.afterClose ?? "next";
    if (moveOn && after !== "stay") {
      if (after === "list") navigate(`/?view=${inbox.view}`);
      else inbox.goNext(t.id);
    } else {
      el.classList.add("sending");
    }
    queueSend({
      path: `/tickets/${t.id}/reply`, body, draftKey, label, ticketId: t.id, seconds,
      onSent: () => {
        toast(mode === "forward" ? "Forwarded" : closing ? `Sent — ${statusLabel(body.status).toLowerCase()}` : "Sent");
        el.classList.remove("sending");
        if (!moveOn || after === "stay") navigate(`/tickets/${t.id}?view=${inbox.view}`, { replace: true });
        else inbox.reloadList();
      },
      onUndo: () => { toast("Send cancelled — your draft is back"); navigate(`/tickets/${t.id}?view=${inbox.view}`); },
    });
  };
  sendBtn.onclick = () => send("in_progress");
  sendCloseBtn.onclick = () => send("closed");
  noteBtn.onclick = busy(noteBtn, async () => {
    const text = editorText(ed);
    if (!text) return;
    const ids = [...mentions.keys()].filter((id) => text.includes(`@${mentions.get(id)}`));
    for (const a of state.agents) if (!ids.includes(a.id) && text.includes(`@${a.name}`)) ids.push(a.id);
    await api(`/tickets/${t.id}/notes`, { method: "POST", body: { body: text, mentions: ids } });
    ed.innerHTML = "";
    storage(draftKey, null);
    toast(ids.length ? `Note added — ${ids.length} mentioned` : "Note added");
    navigate(`/tickets/${t.id}?view=${inbox.view}`, { replace: true });
  });
  ed.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (mode === "note") noteBtn.click();
      else send(e.shiftKey ? "closed" : "in_progress");
    } else if (e.key === "Enter" && e.altKey && e.shiftKey) {
      e.preventDefault();
      if (mode !== "note") send("in_progress");
    } else if (e.key === "5" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      discountBtn.click();
    }
  });

  const el = h("div", { class: "composer" },
    h("div", { class: "composer-box" },
      h("div", { class: "composer-tabs" }, Object.values(tabs), toSummary),
      rcptRows, toolbar, ed, autoEl, filesEl, aiRow,
      h("div", { class: "composer-bar" }, macroBtn, discountBtn, attachBtn, aiBtn, fileInput, h("div", { class: "grow" }), discardBtn, replyBtns, noteBtn)));
  toolbar.append(h("span", { class: "sep" }));
  setMode(mode, false);
  renderAutos();
  return {
    el,
    focus: (m) => { if (m && m !== mode) setMode(m); else ed.focus(); },
    insert: (text) => { if (mode === "note") setMode("reply", false); insertHtmlAtCursor(ed, textToHtml(text)); },
    discount: () => discountBtn.click(),
    newEmailTo: (email) => newEmail({ to: email }),
  };
}

// ---------------------------------------------------------------- New email (creates a ticket)

/**
 * New email (becomes a ticket). From an order page: { order, body, starters, tags } prefill it,
 * "Send & keep open" / "Send & close" replace the status picker, and you stay where you are.
 */
export function newEmail({ to = "", subject = "", body = "", order = null, starters = null, tags = null, onSent = null } = {}) {
  const { ed, toolbar } = richEditor("Write your email…");
  if (body) ed.innerHTML = textToHtml(body);
  const toIn = h("input", { class: "input", value: to, placeholder: "customer@example.com", "aria-label": "To" });
  const ccIn = h("input", { class: "input", placeholder: "Optional", "aria-label": "Cc" });
  const bccIn = h("input", { class: "input", placeholder: "Optional", "aria-label": "Bcc" });
  const subj = h("input", { class: "input", value: subject, placeholder: "Subject", "aria-label": "Subject" });
  const files = [];
  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  const filesEl = h("div", { class: "pending-files" });
  const renderFiles = () => mount(filesEl, files.map((f, i) => h("span", { class: "attachment" }, icon("clip"), f.filename,
    h("button", { "aria-label": `Remove ${f.filename}`, onclick: () => { files.splice(i, 1); renderFiles(); } }, icon("x")))));
  readFiles(fileInput, files, renderFiles);
  const macroBtn = h("button", { class: "tb wide", type: "button" }, icon("bolt"), "Macros");
  macroBtn.onclick = () => pickMacro(null, (_m, r) => insertHtmlAtCursor(ed, textToHtml(r.text))).catch((e) => toast(e.message, true));
  const attachBtn = h("button", { class: "tb wide", type: "button", onclick: () => fileInput.click() }, icon("clip"), "Attach");
  const status = h("select", { class: "input", style: { width: "auto" }, "aria-label": "After sending" },
    h("option", { value: "in_progress" }, "Then mark in progress"), h("option", { value: "closed" }, "Then close"));
  const create = h("button", { class: "btn primary" }, icon("send"), order ? "Send & keep open" : "Send & create ticket");
  const createClose = order ? h("button", { class: "btn" }, icon("check"), "Send & close") : null;
  // Quick starters for common shipment messages (they replace what's written)
  const startersEl = starters?.length ? h("div", { class: "row starters", style: { gap: "6px" } }, h("span", { class: "small muted" }, "Start from:"),
    starters.map((st) => h("button", { class: "view-chip", type: "button", onclick: () => {
      const cur = editorText(ed).trim();
      if (cur && cur !== body.trim() && !confirm("Replace what you've written with this starter?")) return;
      ed.innerHTML = textToHtml(st.text);
      if (st.subject) subj.value = st.subject;
      ed.focus();
    } }, st.label))) : null;
  const ccRow = h("div", { class: "grid2", hidden: true }, h("label", { class: "field" }, h("span", {}, "Cc"), ccIn), h("label", { class: "field" }, h("span", {}, "Bcc"), bccIn));
  const dlg = modal(order ? `Email ${order.customer || "the customer"} about ${order.name}` : "New email", h("div", { class: "stack new-email" },
    h("label", { class: "field" }, h("span", { class: "row", style: { justifyContent: "space-between" } }, "To", h("button", { class: "linkish", type: "button", onclick: () => (ccRow.hidden = !ccRow.hidden) }, "Cc / Bcc")), toIn),
    ccRow,
    h("label", { class: "field" }, h("span", {}, "Subject"), subj),
    startersEl,
    h("div", { class: "composer-box" }, toolbar, ed, filesEl, h("div", { class: "composer-bar" }, macroBtn, attachBtn, fileInput)),
    h("div", { class: "row", style: { justifyContent: "flex-end" } },
      h("span", { class: "small muted", style: { marginRight: "auto" } }, `From ${settingsCache.integrations?.gmail?.email || "support@"}${order ? " · creates a ticket tagged Shipping" : ""}`),
      order ? null : status, createClose, create)), { width: 720 });
  const send = async (statusValue) => {
    const text = editorText(ed);
    if (!parseList(toIn.value).length) { toIn.focus(); throw new Error("Add who to send to"); }
    if (!subj.value.trim()) { subj.focus(); throw new Error("Add a subject"); }
    if (!text) { ed.focus(); throw new Error("Write the email first"); }
    const r = await api("/tickets/new", { method: "POST", body: {
      to: parseList(toIn.value), cc: parseList(ccIn.value), bcc: parseList(bccIn.value), subject: subj.value.trim(),
      html: cleanHtml(ed.innerHTML), text, status: statusValue, attachments: files.map(({ size, ...f }) => f),
      tags: tags ?? undefined, order_name: order?.name,
    } });
    dlg.close();
    refreshCounts();
    if (order) {
      actionToast(statusValue === "closed" ? "Sent — ticket created and closed" : "Sent — ticket created (waiting on the customer)", "Open ticket", () => navigate(`/tickets/${r.ticketId}?view=all`), 8000);
      onSent?.(r.ticketId);
      return;
    }
    toast("Sent — ticket created");
    navigate(`/tickets/${r.ticketId}?view=all`);
  };
  create.onclick = busy(create, () => send(order ? "in_progress" : status.value));
  if (createClose) createClose.onclick = busy(createClose, () => send("closed"));
  if (order) setTimeout(() => { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); }, 0);
  else if (to) setTimeout(() => subj.focus(), 0);
}
