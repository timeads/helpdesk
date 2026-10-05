// One ticket: header + ⋯ menu, threaded conversation with collapsed history, composer, and the
// right pane (Details: ticket fields, AI insights, customer + orders · Activity: audit log).
import { api } from "./api.js";
import { state, navigate, refreshCounts } from "./app.js";
import { h, mount, icon, relTime, fullTime, shortDate, money, humanize, initials, toast, busy, spinner, fileSize, skeletonRows, popover, menuList, modal } from "./ui.js";
import { STATUS, statusLabel, statusBadge, PRIORITY, priorityChip, statusMenu, priorityMenu, assignMenu, snoozeMenu, tagMenu, folderMenu, whenLabel } from "./common.js";
import { buildComposer, loadSettings, settingsCache, newEmail } from "./composer.js";
import { chatBubble, chatControls } from "./chat-agent.js";
import { socialControls } from "./social-agent.js";

const ticketHref = (id, view) => `/tickets/${id}?view=${view}`;

export async function openTicket(inbox, el, id) {
  mount(el, h("div", { class: "convo" }, h("div", { class: "thread" }, skeletonRows(3))));
  let data;
  try {
    [data] = await Promise.all([api(`/tickets/${id}`), loadSettings()]);
  } catch (e) {
    mount(el, h("div", { class: "empty", style: { margin: "auto" } }, e.message));
    return;
  }
  if (inbox.ticketId !== id) return; // moved on
  const t = data.ticket;
  inbox.markRead(id);

  const composer = buildComposer(inbox, t, data);

  const patch = async (body, msg) => {
    const r = await api(`/tickets/${id}`, { method: "PATCH", body });
    Object.assign(t, r.ticket);
    refreshCounts();
    if (msg) toast(msg);
    return r.ticket;
  };
  const leaves = (s) => !["open", "in_progress"].includes(s) || inbox.view === "unassigned";
  const setStatus = async (status, snoozeUntil) => {
    try {
      await patch({ status, snooze_until: snoozeUntil }, status === "snoozed" ? `Snoozed until ${whenLabel(snoozeUntil)}` : `Marked ${statusLabel(status).toLowerCase()}`);
      const after = settingsCache.support?.afterClose ?? "next";
      if (leaves(status) && after === "next") inbox.goNext(id);
      else if (leaves(status) && after === "list") navigate(`/?view=${inbox.view}`);
      else { inbox.reloadList(); redraw(); }
    } catch (e) { toast(e.message, true); }
  };
  const setAssignee = async (aid) => {
    try {
      await patch({ assignee_id: aid }, aid ? `Assigned to ${aid === state.me.id ? "you" : state.agents.find((a) => a.id === aid)?.name}` : "Unassigned");
      inbox.reloadList();
      redraw();
    } catch (e) { toast(e.message, true); }
  };
  const setPriority = async (p) => {
    try { await patch({ priority: p }, p ? `Priority: ${PRIORITY[p]}` : "Priority cleared"); inbox.reloadList(); redraw(); } catch (e) { toast(e.message, true); }
  };
  // Filing: leaving the inbox moves you on like closing does; filing from inside a folder just updates it
  const setFolder = async (folderId, name) => {
    try {
      await patch({ folder_id: folderId }, folderId ? `Moved to ${name}` : "Moved back to the inbox");
      const leavesView = inbox.view.startsWith("f:") ? `f:${folderId}` !== inbox.view : folderId !== null && !["all", "closed", "archived", "spam", "deleted", "mentions"].includes(inbox.view);
      if (leavesView && !inbox.q) inbox.goNext(id);
      else { inbox.reloadList(); redraw(); }
    } catch (e) { toast(e.message, true); }
  };
  let tagTimer;
  const setTags = (tags) => {
    t.tags = tags;
    redraw();
    clearTimeout(tagTimer);
    tagTimer = setTimeout(() => patch({ tags }).then(() => inbox.reloadList()).catch((e) => toast(e.message, true)), 400);
  };

  // ---- Header
  const statusBtn = h("button", { class: `status-pill st-${t.status}`, title: "Change status" });
  const closeBtn = h("button", { class: "btn primary sm" });
  const moreBtn = h("button", { class: "btn sm ghost icon-only", "aria-label": "More actions", title: "More actions" }, icon("dots"));
  const subjectEl = h("h2", { title: "Click to edit the subject", tabindex: 0 });
  const drawHead = () => {
    mount(statusBtn, icon(STATUS[t.status]?.icon ?? "inbox"), statusLabel(t.status), t.status === "snoozed" && t.snoozed_until ? h("span", { class: "small" }, ` · ${whenLabel(t.snoozed_until)}`) : null, icon("chevron"));
    statusBtn.className = `status-pill st-${t.status}`;
    const closed = ["closed", "archived", "spam", "deleted"].includes(t.status);
    mount(closeBtn, icon(closed ? "inbox" : "check"), closed ? "Reopen" : "Close");
    closeBtn.title = closed ? "Reopen (Alt+R)" : "Close (Alt+C)";
    closeBtn.className = closed ? "btn sm" : "btn primary sm";
    subjectEl.textContent = t.subject;
  };
  statusBtn.onclick = () => statusMenu(statusBtn, t.status, setStatus);
  closeBtn.onclick = () => setStatus(["closed", "archived", "spam", "deleted"].includes(t.status) ? "open" : "closed");
  const editSubject = () => {
    const input = h("input", { class: "input subject-edit", value: t.subject, "aria-label": "Subject" });
    subjectEl.replaceWith(input);
    input.focus();
    input.select();
    const done = async (saveIt) => {
      input.replaceWith(subjectEl);
      if (saveIt && input.value.trim() && input.value.trim() !== t.subject) {
        try { await patch({ subject: input.value.trim() }, "Subject updated"); inbox.reloadList(); drawHead(); } catch (e) { toast(e.message, true); }
      }
    };
    input.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
    input.onblur = () => done(true);
  };
  subjectEl.onclick = editSubject;
  subjectEl.onkeydown = (e) => { if (e.key === "Enter") editSubject(); };

  const merge = () => mergeDialog(t, (target) => { refreshCounts(); navigate(ticketHref(target, inbox.view)); inbox.reloadList(); });
  const actions = {
    close: () => setStatus("closed"),
    reopen: () => setStatus("open"),
    inProgress: () => setStatus("in_progress"),
    spam: () => setStatus(t.status === "spam" ? "open" : "spam"),
    snooze: () => snoozeMenu(statusBtn, (until) => setStatus("snoozed", until)),
    priority: () => priorityMenu(statusBtn, t.priority, setPriority),
    assign: () => assignMenu(statusBtn, t.assignee_id, setAssignee),
    tags: () => tagMenu(statusBtn, t.tags, setTags),
    folder: () => folderMenu(statusBtn, t.folder_id ?? null, setFolder),
    assignToMe: () => setAssignee(state.me.id),
    merge,
  };
  moreBtn.onclick = () => popover(moreBtn, menuList([
    t.status !== "closed" ? { label: "Close", icon: "check", hint: "Alt C", run: actions.close } : { label: "Reopen", icon: "inbox", hint: "Alt R", run: actions.reopen },
    t.status !== "in_progress" ? { label: "Mark in progress", icon: "clock", hint: "Alt I", run: actions.inProgress } : null,
    { label: "Snooze…", icon: "moon", hint: "S", run: () => setTimeout(actions.snooze, 0) },
    t.status !== "archived" ? { label: "Archive", icon: "archive", run: () => setStatus("archived") } : null,
    { label: "Merge…", icon: "merge", run: merge },
    { label: t.folder_id ? "Move to another folder…" : "Move to folder…", icon: "folder", hint: "V", run: () => setTimeout(() => actions.folder(), 0) },
    t.folder_id ? { label: "Back to inbox", icon: "inbox", run: () => setFolder(null, null) } : null,
    "-",
    { label: "Assign…", icon: "user", hint: "A", run: () => setTimeout(actions.assign, 0) },
    t.assignee_id !== state.me.id ? { label: "Assign to me", icon: "user", run: actions.assignToMe } : null,
    { label: "Set priority…", icon: "flag", hint: "P", run: () => setTimeout(actions.priority, 0) },
    { label: "Manage tags…", icon: "tag", hint: "T", run: () => setTimeout(actions.tags, 0) },
    { label: "Mark as unread", icon: "eye", run: async () => { await patch({ unread: true }, "Marked unread"); inbox.reloadList(); navigate(`/?view=${inbox.view}`); } },
    "-",
    { label: t.status === "spam" ? "Not spam" : "Mark as spam", icon: "spam", hint: "Alt M", run: actions.spam },
    t.status === "deleted" ? { label: "Restore", icon: "inbox", run: actions.reopen } : { label: "Delete", icon: "trash", danger: true, run: () => setStatus("deleted") },
  ]), { width: 250, align: "right" });

  // ---- Conversation
  const thread = h("div", { class: "thread" }, renderThread(t, data));
  const convo = h("div", { class: "convo" },
    h("div", { class: "convo-head" },
      h("a", { class: "btn ghost sm back-btn", href: `/?view=${inbox.view}`, "data-link": "" }, icon("back"), "Inbox"),
      h("div", { class: "titles" },
        subjectEl,
        h("div", { class: "crumbs" },
          h("span", {}, `#${t.id}`), h("span", {}, "·"),
          h("button", { class: "crumb-customer", onclick: () => el.classList.add("show-customer"), title: "Customer & orders" }, t.customer_name || t.customer_email), h("span", {}, "·"),
          h("span", { title: fullTime(t.created_at) }, `opened ${relTime(t.created_at)}${/\d$/.test(relTime(t.created_at)) ? "" : " ago"}`))),
      h("div", { class: "controls" }, statusBtn, closeBtn, moreBtn)),
    thread,
    composer.el,
  );
  // A website chat that's still a chat: the chat composer instead of email (until it moves to email)
  if (data.chat && data.chat.state !== "email") {
    const live = chatControls(t, data, thread, {
      isCurrent: () => inbox.ticketId === id && document.body.contains(thread),
      onEmail: () => live.el.replaceWith(composer.el),
    });
    composer.el.replaceWith(live.el);
  }
  // Instagram / Facebook: reply under the comment, privately, or by DM
  if (t.channel === "instagram" || t.channel === "facebook") composer.el.replaceWith(socialControls(inbox, t, thread).el);

  // ---- Right pane
  const side = h("aside", { class: "customer", "aria-label": "Details" });
  const detailsTab = h("button", { class: "tab active" }, "Details");
  const activityTab = h("button", { class: "tab" }, "Activity");
  const sideBody = h("div");
  const custEl = h("div", {}, h("div", { class: "cust-card" }, skeletonRows(3)));
  let sideMode = "details";
  const ticketCard = () => {
    const row = (label, value) => h("div", { class: "kv" }, h("span", { class: "k" }, label), h("span", { class: "v" }, value));
    const assignBtn = h("button", { class: "kv-btn" }, t.assignee_name ? [h("span", { class: "avatar xs" }, initials(t.assignee_name)), t.assignee_name] : h("span", { class: "muted" }, "Unassigned"), icon("chevron"));
    assignBtn.onclick = () => assignMenu(assignBtn, t.assignee_id, setAssignee);
    const prioBtn = h("button", { class: "kv-btn" }, t.priority ? [icon("flag"), PRIORITY[t.priority]] : h("span", { class: "muted" }, "None"), icon("chevron"));
    if (t.priority) prioBtn.classList.add(`p-${t.priority}`);
    prioBtn.onclick = () => priorityMenu(prioBtn, t.priority, setPriority);
    const addTag = h("button", { class: "tag-chip add", "aria-label": "Add tags" }, icon("plus"), t.tags.length ? null : "Add tag");
    addTag.onclick = () => tagMenu(addTag, t.tags, setTags);
    return h("div", { class: "cust-card" },
      h("h3", {}, "Ticket"),
      row("Assignee", assignBtn),
      row("Priority", prioBtn),
      row("Folder", (() => {
        const f = state.folders.find((x) => x.id === t.folder_id);
        const b = h("button", { class: "kv-btn", title: "Move to folder (V)" }, f ? [icon("folder"), f.name] : h("span", { class: "muted" }, "Inbox"), icon("chevron"));
        b.onclick = () => folderMenu(b, t.folder_id ?? null, setFolder);
        return b;
      })()),
      row("Status", statusBadge(t.status)),
      t.status === "snoozed" && t.snoozed_until ? row("Back on", whenLabel(t.snoozed_until)) : null,
      row("Created", fullTime(t.created_at)),
      row("Last message", fullTime(t.last_message_at)),
      data.threads.length > 1 ? row("Email threads", String(data.threads.length)) : null,
      h("div", { class: "kv tags-row" }, h("span", { class: "k" }, "Tags"),
        h("span", { class: "v tag-wrap" }, t.tags.map((tag) => h("span", { class: "tag-chip" }, tag,
          h("button", { "aria-label": `Remove ${tag}`, onclick: () => setTags(t.tags.filter((x) => x !== tag)) }, icon("x")))), addTag)));
  };
  const insightsCard = () => {
    if (!settingsCache.integrations?.ai?.connected && !t.ai_summary) return null;
    const btn = h("button", { class: "btn sm ghost" }, icon("spark"), t.ai_summary ? "Refresh" : "Summarize");
    btn.onclick = busy(btn, async () => {
      btn.replaceChildren(spinner(), "Reading…");
      const r = await api(`/tickets/${id}/ai-insights`, { method: "POST" });
      Object.assign(t, r.ticket);
      redraw();
    });
    const tone = { positive: "good", neutral: "", negative: "bad" }[t.ai_sentiment] ?? "";
    return h("div", { class: "cust-card" },
      h("h3", {}, "AI insights", h("span", { style: { marginLeft: "auto" } }, btn)),
      t.ai_summary ? [
        h("p", { class: "ai-summary" }, t.ai_summary),
        h("div", { class: "row", style: { gap: "6px" } },
          t.ai_sentiment ? h("span", { class: `badge ${tone}` }, humanize(t.ai_sentiment)) : null,
          t.ai_type ? h("span", { class: "badge plain" }, humanize(t.ai_type)) : null,
          h("span", { class: "small muted" }, `updated ${relTime(t.ai_updated_at)}`)),
      ] : h("p", { class: "small muted", style: { margin: 0 } }, "A short summary, the customer's mood and what kind of request this is. About 1¢."));
  };
  const drawSide = () => {
    detailsTab.classList.toggle("active", sideMode === "details");
    activityTab.classList.toggle("active", sideMode === "activity");
    if (sideMode === "details") mount(sideBody, ticketCard(), insightsCard(), custEl);
    else mount(sideBody, activityLog(data));
  };
  detailsTab.onclick = () => { sideMode = "details"; drawSide(); };
  activityTab.onclick = () => { sideMode = "activity"; drawSide(); };
  mount(side,
    h("div", { class: "sheet-close" }, h("button", { class: "btn sm", onclick: () => el.classList.remove("show-customer") }, icon("back"), "Back to conversation")),
    h("div", { class: "side-tabs" }, detailsTab, activityTab), sideBody);

  const redraw = () => { drawHead(); drawSide(); };
  el.classList.remove("show-customer");
  mount(el, convo, side);
  redraw();
  convo.classList.add("fade-in");
  requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
  loadCustomer(custEl, t, composer, () => el.classList.remove("show-customer"), merge);

  inbox.detail = {
    id,
    focusReply: (m) => composer.focus(m),
    discount: () => composer.discount(),
    ...actions,
  };
}

// ---------------------------------------------------------------- Thread

const THREAD_EVENTS = new Set(["status", "assigned", "merged", "forwarded", "discount", "auto_reply", "created"]);

function renderThread(t, data) {
  const items = [
    ...data.messages.map((m) => ({ at: m.sent_at, kind: "msg", m })),
    ...data.notes.map((n) => ({ at: n.created_at, kind: "note", n })),
    ...data.events.filter((e) => THREAD_EVENTS.has(e.kind)).map((e) => ({ at: e.created_at, kind: "event", e })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const multi = data.threads.length > 1;
  const subjects = Object.fromEntries(data.threads.map((x) => [x.thread_id, x.subject]));
  const out = [];
  let lastThread = null;
  for (const it of items) {
    if (it.kind === "msg") {
      if (multi && it.m.thread_id && it.m.thread_id !== lastThread) {
        out.push({ ...it, kind: "subject", subject: it.m.subject || subjects[it.m.thread_id] || t.subject });
      }
      lastThread = it.m.thread_id ?? lastThread;
    }
    out.push(it);
  }
  const draw = (it) =>
    it.kind === "msg" ? (it.m.kind ? chatBubble(t, it.m) : renderMessage(t, it.m))
      : it.kind === "note" ? h("div", { class: "note-item" },
        h("div", { class: "note-head" }, icon("note"), `Internal note · ${it.n.agent_name || "Someone"} · ${fullTime(it.n.created_at)}`),
        h("div", { class: "note-body" }, highlightMentions(it.n.body)))
        : it.kind === "subject" ? h("div", { class: "thread-subject" }, icon("mail"), it.subject)
          : h("div", { class: "event-item" }, describeEvent(it.e), " · ", relTime(it.e.created_at));

  // Collapse older history: keep the last two messages (and everything after them) open
  const msgIdx = out.map((x, i) => (x.kind === "msg" ? i : -1)).filter((i) => i >= 0);
  if (msgIdx.length <= 3 || ["chat", "instagram", "facebook"].includes(t.channel)) return out.map(draw);
  const cut = msgIdx[msgIdx.length - 2];
  const hidden = out.slice(0, cut);
  const hiddenMsgs = hidden.filter((x) => x.kind === "msg").length;
  const first = out.find((x) => x.kind === "msg");
  const holder = h("div", { class: "collapsed" });
  const btn = h("button", { class: "collapsed-btn" }, h("span", { class: "n" }, hiddenMsgs), `earlier message${hiddenMsgs === 1 ? "" : "s"}`);
  btn.onclick = () => holder.replaceWith(...hidden.map(draw));
  mount(holder, draw(first), btn);
  return [holder, ...out.slice(cut).map(draw)];
}

function highlightMentions(text) {
  const names = state.agents.map((a) => a.name).sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
  return text.split(re).map((part) => (re.test(part) ? h("span", { class: "mention" }, part) : part));
}

export function describeEvent(e) {
  const who = e.agent_name || "System";
  const [d, source] = (e.detail || "").split("|");
  switch (e.kind) {
    case "assigned":
      if (e.detail === "nobody") return `${who} unassigned the ticket`;
      return e.detail === e.agent_name ? `${who} took this ticket` : `${e.agent_name ? who : "Auto-assigned"} ${e.agent_name ? "assigned to " : "to "}${e.detail}`;
    case "status":
      if (source === "customer replied") return "Reopened — customer replied";
      if (source === "snooze ended") return "Snooze ended — back in the inbox";
      if (source === "archived in Gmail") return "Closed — archived in Gmail";
      return `${who} marked ${statusLabel(d === "pending" ? "in_progress" : d).toLowerCase()}${source ? ` (${source})` : ""}`;
    case "reopened": return "Reopened — customer replied";
    case "received": return "Ticket created from Gmail";
    case "created": return `${who} started this ticket by email`;
    case "tag_added": return `${who} added tag${d.includes(",") ? "s" : ""} ${d}`;
    case "tag_removed": return `${who} removed tag${d.includes(",") ? "s" : ""} ${d}`;
    case "priority": return d === "none" ? `${who} cleared the priority` : `${who} set priority to ${PRIORITY[d]?.toLowerCase() ?? d}`;
    case "subject": return `${who} renamed the ticket “${d}”`;
    case "folder": return d ? `${who} moved this to the ${d} folder` : `${who} moved this back to the inbox`;
    case "merged": return d.startsWith("#") ? `${who} merged ${d}` : d;
    case "mention": return `${who} mentioned ${d}`;
    case "rules": return d;
    case "auto_reply": return `Automatic reply sent (rule: ${d})`;
    case "rule_error": return `Rule failed: ${d}`;
    case "forwarded": return `${who} forwarded to ${d}`;
    case "discount": return `${who} created discount code ${d}`;
    default: return `${e.kind} ${e.detail}`;
  }
}

const ACT_GROUPS = { all: "Everything", messages: "Messages", status: "Status & assignment", tags: "Tags & priority", rules: "Rules & automations" };
const actGroup = (k) => (["status", "assigned", "reopened", "merged", "received", "created"].includes(k) ? "status"
  : ["tag_added", "tag_removed", "priority", "subject"].includes(k) ? "tags"
    : ["rules", "auto_reply", "rule_error"].includes(k) ? "rules" : "other");

function activityLog(data) {
  const filter = h("select", { class: "input", "aria-label": "Show" }, Object.entries(ACT_GROUPS).map(([k, v]) => h("option", { value: k }, v)));
  const list = h("ol", { class: "activity" });
  const entries = [
    ...data.messages.map((m) => ({ at: m.sent_at, group: "messages", icon: m.direction === "in" ? "mail" : "send",
      text: m.direction === "in" ? `Message received via Gmail from ${m.from_name || m.from_email}` : `Message sent via Gmail${m.agent_name ? ` by ${m.agent_name}` : ""}` })),
    ...data.notes.map((n) => ({ at: n.created_at, group: "messages", icon: "note", text: `${n.agent_name || "Someone"} added an internal note` })),
    ...data.events.map((e) => ({ at: e.created_at, group: actGroup(e.kind), icon: e.kind === "rules" || e.kind === "auto_reply" ? "bolt" : e.kind.startsWith("tag") ? "tag" : "activity", text: describeEvent(e) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const draw = () => mount(list, entries.filter((x) => filter.value === "all" || x.group === filter.value).map((x) =>
    h("li", {}, icon(x.icon), h("div", {}, h("div", {}, x.text), h("div", { class: "small muted", title: new Date(x.at).toLocaleString() }, fullTime(x.at))))));
  filter.onchange = draw;
  draw();
  return h("div", { class: "cust-card" }, h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "10px" } }, h("h3", { style: { margin: 0 } }, "Activity"), filter), list);
}

// ---------------------------------------------------------------- Messages

// Conversational mail reads best as text in the app's colors; designed emails need their white sheet.
const isRichHtml = (html) => /<(table|img)\b/i.test(html) || /background(-color)?\s*:/i.test(html);
const QUOTE_RE = /^(On .{5,200}wrote:\s*$|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/m;
const hasFormatting = (html) => /<(b|strong|i|em|u|ul|ol|a)\b/i.test(html);

function renderMessage(t, m) {
  const out = m.direction === "out";
  const name = out ? (m.agent_name || m.from_name || "Support") : (m.from_name || m.from_email);
  // Our own rich-text replies keep their formatting; their HTML is simple enough to show in a frame
  const rich = !!m.body_html && (isRichHtml(m.body_html) || !m.body_text?.trim() || (out && hasFormatting(m.body_html)));
  const body = h("div", { class: "msg-body" + (rich ? " html" : "") });

  if (rich) {
    const frame = h("iframe", { sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", title: `Message from ${name}`, loading: "lazy" });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: cid:; style-src 'unsafe-inline' *; font-src *">
<base target="_blank"><style>
html{background:#fff}
body{margin:0;padding:16px 18px;font:14.5px/1.6 Roboto,-apple-system,Segoe UI,Arial,sans-serif;color:#2b2b2b;overflow-wrap:anywhere;overflow-x:auto}
p{margin:0 0 .8em} a{color:#8a5a10} img{max-width:100%;height:auto} table{max-width:100%!important}
body:not(.show-quotes) .gmail_quote, body:not(.show-quotes) blockquote[type=cite], body:not(.show-quotes) #appendonsend,
body:not(.show-quotes) #divRplyFwdMsg, body:not(.show-quotes) .yahoo_quoted { display:none }
</style></head><body>${m.body_html}</body></html>`;
    const fit = () => {
      try { frame.style.height = frame.contentDocument.body.scrollHeight + 2 + "px"; } catch { /* cross-origin */ }
    };
    frame.addEventListener("load", () => {
      fit();
      frame.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", fit));
      const doc = frame.contentDocument;
      if (doc?.querySelector(".gmail_quote, blockquote[type=cite], #appendonsend, #divRplyFwdMsg, .yahoo_quoted")) {
        const btn = h("button", { class: "btn ghost sm quote-toggle", title: "Show quoted text" }, "•••");
        btn.onclick = () => { const on = doc.body.classList.toggle("show-quotes"); btn.textContent = on ? "Hide quoted text" : "•••"; fit(); };
        body.append(btn);
      }
    });
    body.append(frame);
  } else {
    const text = m.body_text || "";
    const idx = text.search(QUOTE_RE);
    const main = idx > 0 ? text.slice(0, idx).trimEnd() : text;
    const pre = h("pre", {}, main);
    body.append(pre);
    if (idx > 0) {
      const btn = h("button", { class: "btn ghost sm quote-toggle", title: "Show quoted text" }, "•••");
      btn.onclick = () => {
        const showing = pre.textContent !== main;
        pre.textContent = showing ? main : text;
        btn.textContent = showing ? "•••" : "Hide quoted text";
      };
      body.append(btn);
    }
  }

  const recips = [out ? `to ${m.to_emails}` : m.from_email, m.cc_emails ? ` · cc ${m.cc_emails}` : "", m.bcc_emails ? ` · bcc ${m.bcc_emails}` : ""].join("");
  return h("article", { class: "msg" + (out ? " out" : "") },
    h("div", { class: "msg-head" },
      h("div", { class: "avatar" + (out ? " us" : "") }, initials(name)),
      h("div", { style: { minWidth: 0 } }, h("div", { class: "from" }, name), h("div", { class: "addr", title: recips }, recips)),
      h("div", { class: "when", title: new Date(m.sent_at).toLocaleString() }, fullTime(m.sent_at))),
    body,
    m.attachments.length ? h("div", { class: "attachments" }, m.attachments.map((a) =>
      h("a", { class: "attachment", target: "_blank", rel: "noopener", href: `/api/tickets/${t.id}/messages/${m.id}/attachments/${encodeURIComponent(a.id)}` },
        icon("clip"), a.filename, h("span", { class: "muted" }, fileSize(a.size))))) : null,
  );
}

// ---------------------------------------------------------------- Merge

async function mergeDialog(t, done) {
  const { tickets } = await api(`/tickets/${t.id}/merge-suggestions`);
  const chosen = new Set();
  const numIn = h("input", { class: "input", placeholder: "Ticket number, e.g. 1042", inputmode: "numeric", "aria-label": "Ticket number" });
  const list = h("div", { class: "merge-list" });
  const extra = [];
  const go = h("button", { class: "btn primary", disabled: true }, icon("merge"), "Merge");
  const draw = () => {
    mount(list, [...tickets, ...extra].length ? [...tickets, ...extra].map((x) => h("label", { class: "check merge-row" },
      h("input", { type: "checkbox", checked: chosen.has(x.id), onchange: (e) => { e.target.checked ? chosen.add(x.id) : chosen.delete(x.id); draw(); } }),
      h("div", { style: { minWidth: 0, flex: 1 } }, h("div", {}, h("b", {}, `#${x.id} `), x.subject), h("div", { class: "small muted" }, `${statusLabel(x.status)} · ${x.message_count ?? "?"} messages · ${relTime(x.last_message_at)}`)))) :
      h("p", { class: "muted small" }, "No other tickets from this customer. Enter a ticket number to merge another one."));
    go.disabled = !chosen.size;
    mount(go, icon("merge"), chosen.size ? `Merge ${chosen.size} into #${t.id}` : "Merge");
  };
  const addNum = h("button", { class: "btn sm" }, "Add");
  addNum.onclick = busy(addNum, async () => {
    const n = Number(numIn.value.replace(/\D/g, ""));
    if (!n || n === t.id) return;
    const r = await api(`/tickets/${n}`);
    if (!extra.some((x) => x.id === n) && !tickets.some((x) => x.id === n)) extra.push(r.ticket);
    chosen.add(n);
    numIn.value = "";
    draw();
  });
  draw();
  const dlg = modal(`Merge into #${t.id}`, h("div", { class: "stack" },
    h("p", { class: "muted", style: { margin: 0 } }, "Messages, notes and tags from the selected tickets move into this one. The others go to Trash."),
    list,
    h("div", { class: "row", style: { flexWrap: "nowrap" } }, numIn, addNum),
    h("div", { class: "row", style: { justifyContent: "flex-end" } }, go)), { width: 560 });
  go.onclick = busy(go, async () => {
    const r = await api(`/tickets/${t.id}/merge`, { method: "POST", body: { ids: [...chosen] } });
    dlg.close();
    toast(`Merged ${chosen.size} ticket${chosen.size > 1 ? "s" : ""}`);
    done(r.ticketId);
  });
}

// ---------------------------------------------------------------- Customer panel

const FULFILL_TONE = { FULFILLED: "good", UNFULFILLED: "warn", PARTIALLY_FULFILLED: "warn", ON_HOLD: "bad", SCHEDULED: "warn", IN_PROGRESS: "warn" };
const FIN_TONE = { PAID: "st-open", PENDING: "warn", REFUNDED: "st-closed", PARTIALLY_REFUNDED: "warn", VOIDED: "bad", AUTHORIZED: "warn", PARTIALLY_PAID: "warn" };

function addressText(a) {
  if (!a) return "";
  return [a.name, a.company, a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "), a.countryCodeV2 !== "US" ? a.country : null, a.phone].filter(Boolean).join("\n");
}

function orderSummaryText(o) {
  const lines = [`Order ${o.name}, placed ${shortDate(o.createdAt)}:`];
  o.lineItems.nodes.forEach((l) => lines.push(`• ${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`));
  o.fulfillments.flatMap((f) => f.trackingInfo).forEach((tr) => lines.push(`Tracking: ${tr.company ? tr.company + " " : ""}${tr.number}${tr.url ? ` — ${tr.url}` : ""}`));
  return lines.join("\n");
}

async function loadCustomer(el, t, composer, closeSheet, merge) {
  let data;
  try {
    data = await api(`/tickets/customer/${encodeURIComponent(t.customer_email)}`);
  } catch (e) {
    mount(el, h("div", { class: "cust-card" }, h("div", { class: "notice bad" }, e.message)));
    return;
  }
  // Instagram / Facebook: we only know their account, not an email, so there's nothing to look up in Shopify
  const social = t.channel === "instagram" || t.channel === "facebook";
  if (social) data.shopify = null;
  const handle = social && /^@[\w.]+$/.test(t.customer_name ?? "") ? t.customer_name.slice(1) : null;
  const c = data.shopify?.customer;
  const orders = data.shopify?.orders ?? [];
  const name = c?.displayName || t.customer_name || t.customer_email;
  const copy = h("button", { class: "btn ghost sm icon-only", title: "Copy email", "aria-label": "Copy email", onclick: () => navigator.clipboard?.writeText(t.customer_email).then(() => toast("Email copied")) }, icon("copy"));

  const profile = h("div", { class: "cust-card" },
    data.shopify?.demo ? h("div", { class: "demo-flag" }, icon("info"), "Demo data — not from Shopify") : null,
    h("h3", {}, "Customer", c ? h("a", { href: c.adminUrl, target: "_blank", rel: "noopener" }, "View on Shopify", icon("ext")) : null),
    h("div", { class: "cust-id" },
      h("div", { class: "avatar" }, initials(name)),
      h("div", { style: { minWidth: 0, flex: 1 } },
        h("div", { class: "cust-name" }, name),
        social
          ? h("div", { class: "cust-meta" }, t.channel === "instagram" ? "Instagram" : "Facebook",
              handle && t.channel === "instagram" ? [" · ", h("a", { href: `https://www.instagram.com/${handle}/`, target: "_blank", rel: "noopener" }, "profile ", icon("ext"))] : null)
          : h("div", { class: "cust-meta row", style: { gap: "2px" } }, t.customer_email, copy),
        c?.phone ? h("a", { class: "cust-meta", href: `tel:${c.phone}` }, c.phone) : null)),
    c ? h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, c.numberOfOrders), h("span", {}, Number(c.numberOfOrders) === 1 ? "Order" : "Orders")),
      h("div", { class: "stat" }, h("b", {}, money(c.amountSpent.amount, c.amountSpent.currencyCode).replace(/\.00$/, "")), h("span", {}, "Lifetime")),
      h("div", { class: "stat" }, h("b", {}, orders[0] ? money(orders[0].totalPriceSet.shopMoney.amount).replace(/\.00$/, "") : "—"), h("span", {}, "Last order"))) : null,
    c?.tags?.length ? h("div", { class: "tags" }, c.tags.map((tag) => h("span", { class: "badge plain" }, tag))) : null,
    c?.note ? h("div", { class: "notice", style: { marginTop: "12px", whiteSpace: "pre-wrap" } }, c.note) : null,
    !c && data.shopifyError === "not_configured" ? h("div", { class: "notice info", style: { marginTop: "14px" } }, "Connect Shopify to see this customer's orders here.") : null,
    data.shopifyError && data.shopifyError !== "not_configured" ? h("div", { class: "notice bad", style: { marginTop: "14px" } }, data.shopifyError) : null,
    social ? h("div", { class: "notice", style: { marginTop: "14px" } }, "To look up an order, ask for their order number or email (privately), then search it in Shipping → All orders.")
      : !c && !data.shopifyError ? h("div", { class: "notice", style: { marginTop: "14px" } }, "No Shopify customer uses this email. They may have ordered with a different address.") : null,
    social ? null : h("div", { class: "row", style: { marginTop: "12px", gap: "6px" } },
      h("button", { class: "btn sm", onclick: () => newEmail({ to: t.customer_email }) }, icon("mail"), "New email")));

  const ordersCard = data.shopify ? h("div", { class: "cust-card" },
    h("h3", {}, "Orders", orders.length ? h("span", { class: "n" }, orders.length) : null),
    orders.length ? orders.map((o, i) => renderOrder(o, i === 0, t, composer)) : h("div", { class: "small muted" }, "No orders for this email.")) : null;

  const others = data.tickets.filter((x) => x.id !== t.id);
  const active = others.filter((x) => ["open", "in_progress", "snoozed"].includes(x.status));
  const historyCard = others.length ? h("div", { class: "cust-card history" },
    h("h3", {}, "Earlier conversations"),
    active.length ? h("div", { class: "notice info merge-hint" }, `${active.length} other open ticket${active.length > 1 ? "s" : ""} from this customer.`, h("button", { class: "btn sm", onclick: merge }, icon("merge"), "Merge…")) : null,
    others.map((x) => h("a", { href: ticketHref(x.id, "all"), "data-link": "" }, statusBadge(x.status), h("span", { class: "s" }, x.subject), h("span", { class: "small muted" }, relTime(x.last_message_at))))) : null;

  mount(el, profile, ordersCard, historyCard);
  void closeSheet;
}

function renderOrder(o, open, t, composer) {
  const total = o.totalPriceSet.shopMoney;
  const tracks = o.fulfillments.flatMap((f) => f.trackingInfo.map((tr) => ({ ...tr, status: f.displayStatus || f.status })));
  const unfulfilled = ["UNFULFILLED", "PARTIALLY_FULFILLED"].includes(o.displayFulfillmentStatus) && !o.cancelledAt;
  return h("details", { class: "order", open },
    h("summary", {},
      h("div", { class: "o-top" }, h("b", {}, o.name), h("span", { class: "small muted" }, shortDate(o.createdAt)), h("span", { class: "total" }, money(total.amount, total.currencyCode))),
      h("div", { class: "o-badges" },
        o.cancelledAt ? h("span", { class: "badge bad" }, "Cancelled") : null,
        o.displayFinancialStatus ? h("span", { class: `badge ${FIN_TONE[o.displayFinancialStatus] ?? ""}` }, humanize(o.displayFinancialStatus)) : null,
        h("span", { class: `badge ${FULFILL_TONE[o.displayFulfillmentStatus] ?? ""}` }, humanize(o.displayFulfillmentStatus)))),
    h("div", { class: "order-body" },
      o.lineItems.nodes.map((l) => h("div", { class: "line" },
        l.image ? h("img", { src: l.image.url, alt: "", loading: "lazy" }) : h("div", { class: "ph" }),
        h("div", { style: { minWidth: 0 } }, h("div", {}, l.title), l.variantTitle ? h("div", { class: "small muted" }, l.variantTitle) : null),
        h("span", { class: "qty" }, `× ${l.quantity}`))),
      tracks.length ? h("div", { class: "track" },
        h("div", { class: "sub-label" }, "Tracking"),
        tracks.map((tr) => h("div", { class: "row", style: { gap: "6px" } },
          h("span", { class: "badge good" }, humanize(tr.status || "Shipped")),
          tr.url ? h("a", { href: tr.url, target: "_blank", rel: "noopener", class: "mono" }, `${tr.company || ""} ${tr.number}`) : h("span", { class: "mono" }, `${tr.company || ""} ${tr.number}`)))) : null,
      o.shippingAddress ? h("div", {},
        h("div", { class: "sub-label" }, `Ship to${o.shippingLines.nodes[0] ? ` · ${o.shippingLines.nodes[0].title}` : ""}`),
        h("div", { class: "addr-block" }, addressText(o.shippingAddress))) : null,
      o.note ? h("div", { class: "notice small" }, o.note) : null,
      h("div", { class: "order-actions" },
        h("button", { class: "btn sm", onclick: () => { composer.insert(orderSummaryText(o)); document.querySelector(".detail")?.classList.remove("show-customer"); } }, icon("plus"), "Add to reply"),
        h("a", { class: "btn sm" + (unfulfilled ? " dark" : ""), href: `/shipping?order=${encodeURIComponent(o.id)}&ticket=${t.id}`, "data-link": "" }, icon("truck"), unfulfilled ? "Ship" : "Label"),
        h("a", { class: "btn sm ghost icon-only", href: o.adminUrl, target: "_blank", rel: "noopener", title: `Open ${o.name} in Shopify`, "aria-label": `Open ${o.name} in Shopify` }, icon("ext")))));
}
