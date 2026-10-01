import { api } from "./api.js";
import { state, navigate, refreshCounts, viewLabel } from "./app.js";
import { h, mount, icon, relTime, fullTime, shortDate, money, humanize, initials, toast, busy, spinner, fileSize, rugArt, skeletonRows } from "./ui.js";

let inst = null; // the mounted inbox, reused while navigating between tickets
let integrations = null;

function parseLocation() {
  const params = new URLSearchParams(location.search);
  const m = location.pathname.match(/^\/tickets\/(\d+)/);
  return { view: params.get("view") || "open", q: params.get("q") || "", ticketId: m ? Number(m[1]) : null };
}

const ticketHref = (id, view) => `/tickets/${id}?view=${view}`;

export function renderInbox(main) {
  const loc = parseLocation();
  if (inst && inst.main === main && inst.view === loc.view && main.isConnected && main.contains(inst.listPane)) {
    inst.select(loc.ticketId);
    return inst.cleanup;
  }
  inst?.cleanup();
  inst = createInbox(main, loc);
  return inst.cleanup;
}

function createInbox(main, loc) {
  const self = { main, view: loc.view, q: loc.q, tickets: [], ticketId: null, detail: null, selected: new Set() };
  const listEl = h("div", { class: "list", role: "list" }, skeletonRows());
  const search = h("input", { class: "input", type: "search", placeholder: "Search tickets", title: "Search by name, email, subject or ticket #", value: self.q, "aria-label": "Search tickets" });
  const syncBtn = h("button", { class: "btn ghost sm icon-only", title: "Check Gmail for new mail now", "aria-label": "Check for new mail" }, icon("refresh"));
  const totalEl = h("span", { class: "total" });
  const titleRow = h("div", { class: "title-row" }, h("h1", {}, viewLabel(self.view)), totalEl, syncBtn);
  const bulkBar = h("div", { class: "bulk-bar", hidden: true, role: "toolbar", "aria-label": "Selected tickets" });
  self.listPane = h("section", { class: "list-pane", "aria-label": "Tickets" },
    h("div", { class: "list-head" }, titleRow, bulkBar,
      h("div", { class: "search" }, icon("search"), search)),
    listEl,
  );

  // ---- Multi-select: tick tickets, then close / assign / mark pending in one go
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
    const act = (label, body, cls = "btn sm") => {
      const b = h("button", { class: cls }, label);
      b.onclick = busy(b, async () => {
        const ids = [...self.selected];
        const r = await api("/tickets/bulk", { method: "POST", body: { ids, ...body } });
        toast(`${ids.length} ticket${ids.length > 1 ? "s" : ""} ${body.status === "closed" ? "closed" : body.status === "pending" ? "marked pending" : "assigned to you"}`);
        self.selected.clear();
        if (body.status && self.view !== "all" && ids.includes(self.ticketId)) navigate(`/?view=${self.view}`);
        await loadList();
        refreshCounts();
        return r;
      });
      return b;
    };
    mount(bulkBar,
      h("label", { class: "bulk-all" }, allBox, h("b", {}, `${n} selected`)),
      h("div", { class: "row", style: { gap: "6px", marginLeft: "auto" } },
        self.view !== "closed" ? act([icon("check"), "Close"], { status: "closed" }, "btn sm primary") : act("Reopen", { status: "open" }, "btn sm primary"),
        act("Assign to me", { assignee_id: state.me.id }),
        self.view !== "pending" ? act("Pending", { status: "pending" }) : null,
        h("button", { class: "btn sm ghost icon-only", "aria-label": "Clear selection", title: "Clear selection (Esc)", onclick: () => { self.selected.clear(); renderList(); } }, icon("x"))));
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
    searchTimer = setTimeout(() => {
      self.q = search.value.trim();
      loadList();
    }, 250);
  });
  syncBtn.addEventListener("click", busy(syncBtn, async () => {
    const r = await api("/tickets/sync", { method: "POST" });
    toast(r.created ? `${r.created} new ticket${r.created > 1 ? "s" : ""}` : "Inbox is up to date");
    await loadList();
    refreshCounts();
  }));

  async function loadList() {
    const qs = new URLSearchParams({ view: self.view });
    if (self.q) qs.set("q", self.q);
    try {
      const { tickets } = await api("/tickets?" + qs);
      self.tickets = tickets;
      renderList();
    } catch (e) {
      mount(listEl, h("div", { class: "empty" }, e.message));
    }
  }

  function renderList() {
    for (const id of self.selected) if (!self.tickets.some((t) => t.id === id)) self.selected.delete(id);
    renderBulk();
    totalEl.textContent = self.tickets.length ? String(self.tickets.length) + (self.tickets.length === 50 ? "+" : "") : "";
    if (!self.tickets.length) {
      const zero = !self.q && ["open", "mine", "unassigned"].includes(self.view);
      mount(listEl, h("div", { class: "empty fade-in" },
        zero ? rugArt() : null,
        h("h2", {}, self.q ? "No matches" : zero ? "Inbox zero" : "Nothing here"),
        h("p", {}, self.q ? `Nothing matches “${self.q}”. Search covers names, emails, subjects and ticket numbers.`
          : zero ? "New mail to support@ shows up here within a minute." : "Tickets will appear here as their status changes.")));
      return;
    }
    mount(listEl, self.tickets.map((t) =>
      h("a", {
        href: ticketHref(t.id, self.view), "data-link": "", role: "listitem",
        class: "t-row" + (t.unread ? " unread" : "") + (t.id === self.ticketId ? " active" : ""),
        "data-id": t.id,
      },
        h("span", {
          class: "pick" + (self.selected.has(t.id) ? " on" : ""), role: "checkbox", tabindex: 0,
          "aria-checked": self.selected.has(t.id), "aria-label": `Select ticket from ${t.customer_name || t.customer_email}`,
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSelect(t.id); },
          onkeydown: (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); toggleSelect(t.id); } },
        }, icon("check")),
        h("div", { class: "top" },
          h("span", { class: "who" }, t.customer_name || t.customer_email),
          h("span", { class: "when", title: fullTime(t.last_message_at) }, relTime(t.last_message_at))),
        h("div", { class: "subj" }, t.subject),
        h("div", { class: "snip" }, t.snippet),
        h("div", { class: "meta" },
          ["all", "closed"].includes(self.view) ? h("span", { class: `badge ${t.status}` }, t.status === "pending" ? "Pending" : humanize(t.status)) : null,
          t.assignee_name
            ? h("span", { class: "assignee" }, h("span", { class: "avatar" }, initials(t.assignee_name)), t.assignee_name)
            : h("span", { class: "badge warn plain" }, "Unassigned"),
          t.message_count > 1 ? h("span", { class: "small muted", style: { marginLeft: "auto" } }, `${t.message_count} messages`) : null),
      )));
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
      navigate(next ? ticketHref(next, self.view) : `/?view=${self.view}`);
    };
    const row = listEl.querySelector(`.t-row[data-id="${fromId}"]`);
    if (row && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      row.classList.add("leaving");
      setTimeout(go, 180);
    } else go();
  };

  self.select = (id) => {
    self.ticketId = id;
    main.classList.toggle("has-ticket", !!id);
    listEl.querySelectorAll(".t-row").forEach((r) => r.classList.toggle("active", Number(r.dataset.id) === id));
    if (!id) {
      mount(detailEl, h("div", { class: "empty", style: { margin: "auto" } },
        h("h2", {}, self.tickets.length ? "Pick a ticket" : "Nothing to answer"),
        h("p", {}, "Keyboard: ", h("kbd", {}, "j"), " ", h("kbd", {}, "k"), " move · ", h("kbd", {}, "r"), " reply · ", h("kbd", {}, "a"), " assign to me · ", h("kbd", {}, "e"), " close · ", h("kbd", {}, "x"), " select")));
      return;
    }
    openTicket(self, detailEl, id);
  };

  const onKey = (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = self.tickets.findIndex((t) => t.id === self.ticketId);
    if (e.key === "j" || e.key === "k") {
      const t = self.tickets[e.key === "j" ? i + 1 : Math.max(0, i - 1)];
      if (t) navigate(ticketHref(t.id, self.view));
    } else if (e.key === "r" && self.detail) {
      e.preventDefault();
      self.detail.focusReply();
    } else if (e.key === "e" && self.detail) {
      self.detail.close();
    } else if (e.key === "a" && self.detail) {
      self.detail.assignToMe();
    } else if (e.key === "x" && self.ticketId) {
      toggleSelect(self.ticketId);
    } else if (e.key === "Escape" && self.selected.size) {
      self.selected.clear();
      renderList();
    }
  };
  document.addEventListener("keydown", onKey);
  const poll = setInterval(() => {
    if (!document.hidden && !self.q) loadList();
  }, 30000);

  self.cleanup = () => {
    document.removeEventListener("keydown", onKey);
    clearInterval(poll);
    inst = null;
  };
  self.reloadList = loadList;

  loadList().then(() => {
    // On wide screens open the first ticket automatically
    if (!loc.ticketId && self.tickets[0] && matchMedia("(min-width: 761px)").matches) {
      navigate(ticketHref(self.tickets[0].id, self.view), { replace: true });
    }
  });
  self.select(loc.ticketId);
  return self;
}

// ---------------------------------------------------------------- Ticket detail

async function openTicket(inbox, el, id) {
  mount(el, h("div", { class: "convo" }, h("div", { class: "thread" }, skeletonRows(3))));
  let data;
  try {
    [data] = await Promise.all([
      api(`/tickets/${id}`),
      integrations ? null : api("/settings").then((s) => (integrations = s.integrations)).catch(() => (integrations = {})),
    ]);
  } catch (e) {
    mount(el, h("div", { class: "empty", style: { margin: "auto" } }, e.message));
    return;
  }
  if (inbox.ticketId !== id) return; // user moved on
  const t = data.ticket;
  const row = inbox.tickets.find((x) => x.id === id);
  if (row && row.unread) {
    row.unread = 0;
    el.ownerDocument.querySelector(`.t-row[data-id="${id}"]`)?.classList.remove("unread");
  }

  const composer = buildComposer(inbox, t);
  const assignee = h("select", { class: "input", "aria-label": "Assignee" },
    h("option", { value: "" }, "Unassigned"),
    state.agents.map((a) => h("option", { value: a.id, selected: a.id === t.assignee_id }, a.name)));
  const status = h("select", { class: `input status-${t.status}`, "aria-label": "Status" },
    ["open", "pending", "closed"].map((s) => h("option", { value: s, selected: s === t.status }, s === "pending" ? "Pending" : humanize(s))));

  const patch = async (body) => {
    const r = await api(`/tickets/${id}`, { method: "PATCH", body });
    Object.assign(t, r.ticket);
    refreshCounts();
    return r.ticket;
  };
  assignee.addEventListener("change", async () => {
    try {
      await patch({ assignee_id: assignee.value ? Number(assignee.value) : null });
      toast(assignee.value ? `Assigned to ${assignee.selectedOptions[0].textContent}` : "Unassigned");
      inbox.reloadList();
    } catch (e) { toast(e.message, true); }
  });
  status.addEventListener("change", async () => {
    status.className = `input status-${status.value}`;
    try {
      await patch({ status: status.value });
      if (status.value === "closed") {
        toast("Ticket closed");
        inbox.goNext(id);
      } else inbox.reloadList();
    } catch (e) { toast(e.message, true); }
  });

  const thread = h("div", { class: "thread" }, renderThread(t, data));
  const convo = h("div", { class: "convo" },
    h("div", { class: "convo-head" },
      h("a", { class: "btn ghost sm back-btn", href: `/?view=${inbox.view}`, "data-link": "" }, icon("back"), "Inbox"),
      h("div", { class: "titles" },
        h("h2", {}, t.subject),
        h("div", { class: "crumbs" },
          h("span", {}, `#${t.id}`), h("span", {}, "·"),
          h("button", { class: "crumb-customer", onclick: () => el.classList.add("show-customer"), title: "Customer & orders" }, t.customer_name || t.customer_email), h("span", {}, "·"),
          h("span", {}, `opened ${fullTime(t.created_at)}`))),
      h("div", { class: "controls" }, assignee, status)),
    thread,
    composer.el,
  );
  const customer = h("aside", { class: "customer", "aria-label": "Customer" }, h("div", { class: "cust-card" }, skeletonRows(4)));
  el.classList.remove("show-customer");
  mount(el, convo, customer);
  convo.classList.add("fade-in");
  requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
  loadCustomer(customer, t, composer, () => el.classList.remove("show-customer"));

  inbox.detail = {
    focusReply: () => composer.focus(),
    close: async () => {
      try {
        await patch({ status: "closed" });
        toast("Ticket closed");
        inbox.goNext(id);
      } catch (e) { toast(e.message, true); }
    },
    assignToMe: async () => {
      assignee.value = state.me.id;
      assignee.dispatchEvent(new Event("change"));
    },
  };
}

function renderThread(t, data) {
  const items = [
    ...data.messages.map((m) => ({ at: m.sent_at, el: () => renderMessage(t, m) })),
    ...data.notes.map((n) => ({ at: n.created_at, el: () => h("div", { class: "note-item" },
      h("div", { class: "note-head" }, icon("note"), `Internal note · ${n.agent_name || "Someone"} · ${fullTime(n.created_at)}`),
      h("div", { class: "note-body" }, n.body)) })),
    ...data.events.map((e) => ({ at: e.created_at, el: () => h("div", { class: "event-item" }, describeEvent(e), " · ", relTime(e.created_at)) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return items.map((i) => i.el());
}

function describeEvent(e) {
  const who = e.agent_name || "System";
  if (e.kind === "assigned") {
    if (e.detail === "nobody") return `${who} unassigned the ticket`;
    return e.detail === e.agent_name ? `${who} took this ticket` : `${who} assigned to ${e.detail}`;
  }
  if (e.kind === "status") return `${who} marked ${e.detail === "pending" ? "pending" : e.detail}`;
  if (e.kind === "reopened") return "Reopened — customer replied";
  return `${e.kind} ${e.detail}`;
}

// Conversational mail (a person typing in Gmail/Outlook) reads best as text in the app's own colors;
// only designed emails — images, tables, colored backgrounds — need the white sheet they were made for.
const isRichHtml = (html) => /<(table|img)\b/i.test(html) || /background(-color)?\s*:/i.test(html);

const QUOTE_RE = /^(On .{5,200}wrote:\s*$|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/m;

function renderMessage(t, m) {
  const out = m.direction === "out";
  const name = out ? (m.agent_name || m.from_name || "Support") : (m.from_name || m.from_email);
  const rich = !!m.body_html && (isRichHtml(m.body_html) || !m.body_text?.trim());
  const body = h("div", { class: "msg-body" + (rich ? " html" : "") });

  if (rich) {
    const frame = h("iframe", {
      sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      title: `Message from ${name}`,
      loading: "lazy",
    });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data: cid:; style-src 'unsafe-inline' *; font-src *">
<base target="_blank"><style>
html{background:#fff}
body{margin:0;padding:16px 18px;font:14.5px/1.6 Roboto,-apple-system,Segoe UI,Arial,sans-serif;color:#2b2b2b;overflow-wrap:anywhere;overflow-x:auto}
a{color:#8a5a10} img{max-width:100%;height:auto} table{max-width:100%!important}
body:not(.show-quotes) .gmail_quote, body:not(.show-quotes) blockquote[type=cite], body:not(.show-quotes) #appendonsend,
body:not(.show-quotes) #divRplyFwdMsg, body:not(.show-quotes) .yahoo_quoted { display:none }
</style></head><body>${m.body_html}</body></html>`;
    const fit = () => {
      try {
        // body.scrollHeight ignores the iframe's default 150px viewport, so short mails don't get blank space
        frame.style.height = frame.contentDocument.body.scrollHeight + 2 + "px";
      } catch { /* cross-origin */ }
    };
    frame.addEventListener("load", () => {
      fit();
      frame.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", fit));
      const doc = frame.contentDocument;
      if (doc?.querySelector(".gmail_quote, blockquote[type=cite], #appendonsend, #divRplyFwdMsg, .yahoo_quoted")) {
        const btn = h("button", { class: "btn ghost sm quote-toggle" }, "Show earlier messages");
        btn.onclick = () => {
          const on = doc.body.classList.toggle("show-quotes");
          btn.textContent = on ? "Hide earlier messages" : "Show earlier messages";
          fit();
        };
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
      const btn = h("button", { class: "btn ghost sm quote-toggle" }, "Show earlier messages");
      btn.onclick = () => {
        const showing = pre.textContent !== main;
        pre.textContent = showing ? main : text;
        btn.textContent = showing ? "Show earlier messages" : "Hide earlier messages";
      };
      body.append(btn);
    }
  }

  return h("article", { class: "msg" + (out ? " out" : "") },
    h("div", { class: "msg-head" },
      h("div", { class: "avatar" + (out ? " us" : "") }, initials(name)),
      h("div", { style: { minWidth: 0 } },
        h("div", { class: "from" }, name),
        h("div", { class: "addr" }, out ? `to ${m.to_emails}` : m.from_email, m.cc_emails ? ` · cc ${m.cc_emails}` : "")),
      h("div", { class: "when", title: new Date(m.sent_at).toLocaleString() }, fullTime(m.sent_at))),
    body,
    m.attachments.length ? h("div", { class: "attachments" }, m.attachments.map((a) =>
      h("a", { class: "attachment", target: "_blank", rel: "noopener", href: `/api/tickets/${t.id}/messages/${m.id}/attachments/${encodeURIComponent(a.id)}` },
        icon("clip"), a.filename, h("span", { class: "muted" }, fileSize(a.size))))) : null,
  );
}

// ---------------------------------------------------------------- Composer

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
  return null;
}

const firstName = (t) => (t.customer_name || "").split(/\s+/)[0] || "there";

function buildComposer(inbox, t) {
  let mode = "reply";
  const files = [];
  const draftKey = `draft:${t.id}`;
  const replyPlaceholder = `Reply to ${t.customer_name?.split(/\s+/)[0] || t.customer_email}…`;
  const ta = h("textarea", { placeholder: replyPlaceholder, "aria-label": "Reply" });
  ta.value = storage(draftKey) || "";
  ta.addEventListener("input", () => storage(draftKey, ta.value || null));

  const fileInput = h("input", { type: "file", multiple: true, hidden: true });
  const filesEl = h("div", { class: "pending-files" });
  const renderFiles = () => mount(filesEl, files.map((f, i) =>
    h("span", { class: "attachment" }, icon("clip"), f.filename, h("span", { class: "muted" }, fileSize(f.size)),
      h("button", { "aria-label": `Remove ${f.filename}`, onclick: () => { files.splice(i, 1); renderFiles(); } }, icon("x")))));
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
    renderFiles();
  });

  const tabReply = h("button", { class: "tab active" }, "Reply");
  const tabNote = h("button", { class: "tab" }, "Internal note");
  const toLine = h("span", { class: "to" }, `To ${t.customer_email}`);
  const setMode = (m) => {
    mode = m;
    tabReply.classList.toggle("active", m === "reply");
    tabNote.classList.toggle("active", m === "note");
    el.classList.toggle("note-mode", m === "note");
    ta.placeholder = m === "note" ? "Only your team sees notes…" : replyPlaceholder;
    toLine.textContent = m === "note" ? "Visible to your team only" : `To ${t.customer_email}`;
    replyBtns.hidden = m !== "reply";
    noteBtn.hidden = m !== "note";
    attachBtn.hidden = m !== "reply";
    ta.focus();
  };
  tabReply.onclick = () => setMode("reply");
  tabNote.onclick = () => setMode("note");

  // Saved replies
  const macroWrap = h("div", { class: "menu" });
  const macroBtn = h("button", { class: "btn sm ghost", "aria-haspopup": "menu" }, icon("note"), "Saved replies");
  macroWrap.append(macroBtn);
  let pop = null;
  const closePop = () => { pop?.remove(); pop = null; };
  macroBtn.onclick = async (e) => {
    e.stopPropagation();
    if (pop) return closePop();
    pop = h("div", { class: "menu-pop", role: "menu" }, h("div", { class: "loading" }, spinner()));
    macroWrap.append(pop);
    const { macros } = await api("/macros");
    const filter = h("input", { class: "input", placeholder: "Filter saved replies…", style: { marginBottom: "6px" } });
    const listEl = h("div");
    const draw = () => mount(listEl, macros
      .filter((m) => (m.name + m.body).toLowerCase().includes(filter.value.toLowerCase()))
      .map((m) => h("button", { role: "menuitem", onclick: () => {
        insertText(ta, m.body.replace(/\{\{\s*first_name\s*\}\}/g, firstName(t)).replace(/\{\{\s*agent_name\s*\}\}/g, state.me.name));
        closePop();
      } }, m.name, h("small", {}, m.body))));
    filter.oninput = draw;
    draw();
    mount(pop, filter, macros.length ? listEl : h("div", { class: "muted small", style: { padding: "8px" } }, "No saved replies yet. Add them in Settings → Saved replies."));
    filter.focus();
  };
  document.addEventListener("click", (e) => { if (pop && !macroWrap.contains(e.target)) closePop(); });
  macroWrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { closePop(); macroBtn.focus(); } });

  const attachBtn = h("button", { class: "btn sm ghost", onclick: () => fileInput.click() }, icon("clip"), "Attach");

  // AI draft
  const aiRow = h("div", { class: "ai-row", hidden: true });
  const aiInstr = h("input", { class: "input", placeholder: "Optional: what should the reply do? e.g. offer a replacement" });
  const aiGo = h("button", { class: "btn sm dark" }, "Write draft");
  aiRow.append(aiInstr, aiGo);
  const aiBtn = integrations?.ai?.connected
    ? h("button", { class: "btn sm ghost", title: "Draft a reply with AI (uses your Anthropic key; about 1–2¢ per draft)", onclick: () => { aiRow.hidden = !aiRow.hidden; if (!aiRow.hidden) aiInstr.focus(); } }, icon("spark"), "Draft with AI")
    : null;
  const runAi = busy(aiGo, async () => {
    aiGo.replaceChildren(spinner(), "Writing…");
    try {
      const { draft } = await api(`/tickets/${t.id}/ai-draft`, { method: "POST", body: { instruction: aiInstr.value.trim() || undefined } });
      ta.value = draft;
      storage(draftKey, draft);
      aiRow.hidden = true;
      setMode("reply");
      toast("Draft ready — read it over before sending");
    } finally {
      aiGo.replaceChildren("Write draft");
    }
  });
  aiGo.onclick = runAi;
  aiInstr.addEventListener("keydown", (e) => { if (e.key === "Enter") runAi(); });

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl";
  const sendBtn = h("button", { class: "btn", title: `Send and mark pending — waiting on the customer (${mod}+Enter)` }, "Send", h("kbd", {}, `${mod}↵`));
  const sendCloseBtn = h("button", { class: "btn primary", title: `Send, close, and open the next ticket (${mod}+Shift+Enter)` }, icon("send"), "Send & close", h("kbd", {}, `${mod}⇧↵`));
  const replyBtns = h("div", { class: "row send-group", style: { gap: "6px" } }, sendBtn, sendCloseBtn);
  const noteBtn = h("button", { class: "btn dark", hidden: true }, "Add note");

  const send = (close) => async () => {
    const text = ta.value.trim();
    if (!text) { toast("Write a reply first", true); ta.focus(); return; }
    sendBtn.disabled = sendCloseBtn.disabled = true;
    const target = close ? sendCloseBtn : sendBtn;
    const label = [...target.childNodes];
    target.replaceChildren(spinner(), "Sending…");
    try {
      await api(`/tickets/${t.id}/reply`, {
        method: "POST",
        body: { text, status: close ? "closed" : "pending", attachments: files.map(({ size, ...f }) => f) },
      });
      storage(draftKey, null);
      refreshCounts();
      toast(close ? "Sent and closed" : "Sent — waiting on the customer");
      if (close || ["open", "mine", "unassigned"].includes(inbox.view)) inbox.goNext(t.id);
      else navigate(ticketHref(t.id, inbox.view), { replace: true });
    } catch (e) {
      toast(e.message, true);
      target.replaceChildren(...label);
    } finally {
      sendBtn.disabled = sendCloseBtn.disabled = false;
    }
  };
  sendBtn.onclick = send(false);
  sendCloseBtn.onclick = send(true);
  noteBtn.onclick = busy(noteBtn, async () => {
    if (!ta.value.trim()) return;
    await api(`/tickets/${t.id}/notes`, { method: "POST", body: { body: ta.value } });
    ta.value = "";
    storage(draftKey, null);
    toast("Note added");
    navigate(ticketHref(t.id, inbox.view), { replace: true });
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (mode === "note") noteBtn.click();
      else (e.shiftKey ? sendCloseBtn : sendBtn).click();
    }
  });

  const el = h("div", { class: "composer" },
    h("div", { class: "composer-box" },
      h("div", { class: "composer-tabs" }, tabReply, tabNote, toLine),
      ta, filesEl, aiRow,
      h("div", { class: "composer-bar" }, macroWrap, attachBtn, aiBtn, fileInput, h("div", { class: "grow" }), replyBtns, noteBtn)),
  );
  return { el, focus: () => ta.focus(), insert: (text) => { setMode("reply"); insertText(ta, text); } };
}

function insertText(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const sep = before && !before.endsWith("\n") ? "\n\n" : "";
  ta.value = before + sep + text + ta.value.slice(end);
  ta.dispatchEvent(new Event("input"));
  ta.focus();
  ta.selectionStart = ta.selectionEnd = (before + sep + text).length;
}

// ---------------------------------------------------------------- Customer panel

const FULFILL_TONE = { FULFILLED: "good", UNFULFILLED: "warn", PARTIALLY_FULFILLED: "warn", ON_HOLD: "bad", SCHEDULED: "warn", IN_PROGRESS: "warn" };
const FIN_TONE = { PAID: "open", PENDING: "warn", REFUNDED: "closed", PARTIALLY_REFUNDED: "warn", VOIDED: "bad", AUTHORIZED: "warn", PARTIALLY_PAID: "warn" };

function addressText(a) {
  if (!a) return "";
  return [a.name, a.company, a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "), a.countryCodeV2 !== "US" ? a.country : null, a.phone]
    .filter(Boolean).join("\n");
}

function orderSummaryText(o) {
  const lines = [`Order ${o.name}, placed ${shortDate(o.createdAt)}:`];
  o.lineItems.nodes.forEach((l) => lines.push(`• ${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`));
  const tracks = o.fulfillments.flatMap((f) => f.trackingInfo);
  tracks.forEach((tr) => lines.push(`Tracking: ${tr.company ? tr.company + " " : ""}${tr.number}${tr.url ? ` — ${tr.url}` : ""}`));
  return lines.join("\n");
}

async function loadCustomer(el, t, composer, closeSheet) {
  let data;
  try {
    data = await api(`/tickets/customer/${encodeURIComponent(t.customer_email)}`);
  } catch (e) {
    mount(el, h("div", { class: "cust-card" }, h("div", { class: "notice bad" }, e.message)));
    return;
  }
  const c = data.shopify?.customer;
  const orders = data.shopify?.orders ?? [];
  const name = c?.displayName || t.customer_name || t.customer_email;

  const sheetBar = h("div", { class: "sheet-close" },
    h("button", { class: "btn sm", onclick: closeSheet }, icon("back"), "Back to conversation"));
  const profile = h("div", { class: "cust-card" },
    data.shopify?.demo ? h("div", { class: "demo-flag" }, icon("info"), "Demo data — not from Shopify") : null,
    h("h3", {}, "Customer", c ? h("a", { href: c.adminUrl, target: "_blank", rel: "noopener" }, "Open in Shopify", icon("ext")) : null),
    h("div", { class: "cust-id" },
      h("div", { class: "avatar" }, initials(name)),
      h("div", { style: { minWidth: 0 } },
        h("div", { class: "cust-name" }, name),
        h("div", { class: "cust-meta" }, t.customer_email),
        c?.phone ? h("div", { class: "cust-meta" }, c.phone) : null)),
    c ? h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", {}, c.numberOfOrders), h("span", {}, c.numberOfOrders === "1" || c.numberOfOrders === 1 ? "Order" : "Orders")),
      h("div", { class: "stat" }, h("b", {}, money(c.amountSpent.amount, c.amountSpent.currencyCode).replace(/\.00$/, "")), h("span", {}, "Lifetime")),
      h("div", { class: "stat" }, h("b", {}, new Date(c.createdAt).getFullYear()), h("span", {}, "Since"))) : null,
    c?.tags?.length ? h("div", { class: "tags" }, c.tags.map((tag) => h("span", { class: "badge plain" }, tag))) : null,
    c?.note ? h("div", { class: "notice", style: { marginTop: "12px", whiteSpace: "pre-wrap" } }, c.note) : null,
    !c && data.shopifyError === "not_configured" ? h("div", { class: "notice info", style: { marginTop: "14px" } }, "Connect Shopify to see this customer's orders here. Steps are in the README.") : null,
    data.shopifyError && data.shopifyError !== "not_configured" ? h("div", { class: "notice bad", style: { marginTop: "14px" } }, data.shopifyError) : null,
    !c && !data.shopifyError ? h("div", { class: "notice", style: { marginTop: "14px" } }, "No Shopify customer uses this email. They may have ordered with a different address.") : null,
  );

  const ordersCard = data.shopify ? h("div", { class: "cust-card" },
    h("h3", {}, "Orders", orders.length ? h("span", { class: "n" }, orders.length) : null),
    orders.length ? orders.map((o, i) => renderOrder(o, i === 0, t, composer)) : h("div", { class: "small muted" }, "No orders for this email."),
  ) : null;

  const others = data.tickets.filter((x) => x.id !== t.id);
  const historyCard = others.length ? h("div", { class: "cust-card history" },
    h("h3", {}, "Earlier conversations"),
    others.map((x) => h("a", { href: ticketHref(x.id, "all"), "data-link": "" },
      h("span", { class: `badge ${x.status}` }, x.status === "pending" ? "Pending" : humanize(x.status)),
      h("span", { class: "s" }, x.subject),
      h("span", { class: "small muted" }, relTime(x.last_message_at))))) : null;

  mount(el, sheetBar, profile, ordersCard, historyCard);
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
