// Repair manual: topics written by AI from finished repair conversations, with the photos and
// videos customers sent and a running record of every case. Topics can be edited and published;
// published ones also guide AI reply drafts.
import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, icon, toast, busy, skeletonRows, shortDate, modal, growInput, spinner } from "./ui.js";
import { manualTabs, renderKb } from "./kb.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");

/** Small, safe Markdown: headings, numbered and bulleted lists, paragraphs, bold/italic/code. */
export function markdown(src) {
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of String(src ?? "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); closeList(); const n = Math.min(4, m[1].length + 1); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) { flushPara(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[2])}</li>`); continue; }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flushPara(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return out.join("");
}

// The update keeps running while you click around the manual
const job = { running: false, stop: false, read: 0, recent: [], onUpdate: null };

const mediaUrl = (m) => `/api/tickets/${m.ticket_id}/messages/${m.message_id}/attachments/${encodeURIComponent(m.attachment_id)}`;

export function renderManual(main) {
  if (location.pathname.split("/")[2] === "kb") return renderKb(main);
  const isAdmin = state.me.role === "admin";
  const id = Number(location.pathname.split("/")[2]) || null;
  const st = { topics: [], q: "", pending: 0, scanned: 0, repairs: 0, ai: false };
  const statusEl = h("div");
  const listEl = h("div", { class: "manual-list" }, skeletonRows(6));
  const detailEl = h("div", { class: "manual-detail" });
  const search = h("input", { class: "input", type: "search", placeholder: "Search topics, machines, symptoms", "aria-label": "Search the manual" });
  search.oninput = () => { st.q = search.value.trim().toLowerCase(); drawList(); };
  const newBtn = h("button", { class: "btn sm", onclick: newTopic }, icon("plus"), "New topic");
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between" } },
        h("div", {}, h("h1", {}, "Repair manual"), h("p", { class: "sub" }, "Written by AI from your repair conversations — your replies, the customer's photos and videos — and kept up to date as more come in.")),
        h("div", { class: "row" }, manualTabs("repairs"), newBtn)))),
    h("div", { class: "page-inner wide" }, statusEl,
      h("div", { class: "manual-layout" + (id ? " has-topic" : "") },
        h("div", { class: "manual-side" }, h("div", { class: "search" }, icon("search"), search), listEl),
        detailEl))));

  async function load() {
    try {
      const r = await api("/manual");
      Object.assign(st, { topics: r.topics, pending: r.pending, scanned: r.scanned, repairs: r.repairs, ai: r.ai });
      drawStatus(job.running ? { text: `Read ${job.read} conversation${job.read === 1 ? "" : "s"}${st.pending ? ` · ${st.pending} to go` : ""}`, recent: job.recent } : null);
      drawList();
      if (id) openTopic(id);
      else drawEmptyDetail();
    } catch (e) {
      mount(listEl, h("div", { class: "notice bad" }, e.message));
    }
  }

  // ---- The AI pass: read waiting repair conversations a few at a time
  function drawStatus(progress) {
    if (!isAdmin) return mount(statusEl);
    if (!st.ai) return mount(statusEl, h("div", { class: "notice info manual-status" }, "Add an Anthropic API key in Settings → Connections so AI can write the manual from your repair conversations."));
    const run = h("button", { class: "btn primary sm" }, icon("spark"), st.topics.length ? "Update from tickets" : "Build the manual");
    run.onclick = () => scan();
    const stop = h("button", { class: "btn sm", onclick: () => { job.stop = true; stop.disabled = true; stop.textContent = "Stopping after this batch…"; } }, "Stop");
    mount(statusEl, h("div", { class: "card manual-status" },
      h("div", { style: { minWidth: 0, flex: 1 } },
        job.running
          ? h("div", { class: "row", style: { gap: "8px" } }, spinner(), h("b", {}, progress?.text ?? "Reading repair conversations…"))
          : h("b", {}, st.pending ? `${st.pending} finished repair conversation${st.pending === 1 ? "" : "s"} waiting to be read` : "Up to date"),
        h("div", { class: "small muted" }, `${st.scanned} conversation${st.scanned === 1 ? "" : "s"} read so far · ${st.repairs} were repairs. Closed tickets tagged Repairs (or that mention a broken, jammed or not-cutting machine) are read; photos are looked at, videos are attached.`),
        progress?.recent?.length ? h("div", { class: "small", style: { marginTop: "6px" } }, "Updated: ", progress.recent.slice(-6).map((t, i) => [i ? ", " : "", h("a", { href: `/manual/${t.id}`, "data-link": "" }, t.title), t.isNew ? h("span", { class: "muted" }, " (new)") : null])) : null),
      job.running ? stop : st.pending ? run : null));
  }

  async function scan() {
    if (job.running) return;
    Object.assign(job, { running: true, stop: false, read: 0, recent: [] });
    const show = () => job.onUpdate?.();
    show();
    try {
      while (!job.stop) {
        const r = await api("/manual/scan", { method: "POST", body: { size: 4 } });
        job.read += r.read;
        job.remaining = r.remaining;
        job.scannedAdd = (job.scannedAdd ?? 0) + r.read;
        job.repairsAdd = (job.repairsAdd ?? 0) + r.repairs;
        for (const t of r.topics) { const i = job.recent.findIndex((x) => x.id === t.id); if (i >= 0) job.recent.splice(i, 1); job.recent.push(t); }
        job.topicsChanged = r.topics.length > 0;
        show();
        if (!r.read || !r.remaining) break;
      }
      toast(job.stop ? "Stopped — pick up where you left off any time" : "The manual is up to date");
    } catch (e) {
      toast(e.message, true);
    } finally {
      job.running = false;
      job.topicsChanged = true;
      show();
    }
  }
  // Whichever manual page is on screen shows the progress
  job.onUpdate = async () => {
    if (!listEl.isConnected) return;
    if (job.remaining !== undefined) st.pending = job.remaining;
    if (job.topicsChanged) {
      job.topicsChanged = false;
      const fresh = await api("/manual").catch(() => null);
      if (fresh) Object.assign(st, { topics: fresh.topics, pending: fresh.pending, scanned: fresh.scanned, repairs: fresh.repairs });
      drawList();
    }
    drawStatus(job.running ? { text: `Read ${job.read} conversation${job.read === 1 ? "" : "s"}${st.pending ? ` · ${st.pending} to go` : ""}`, recent: job.recent } : { recent: job.recent });
  };

  // ---- Topic list, grouped by machine
  function drawList() {
    const q = st.q;
    const shown = st.topics.filter((t) => !q || `${t.title} ${t.product} ${t.summary}`.toLowerCase().includes(q));
    if (!st.topics.length) return mount(listEl, h("div", { class: "empty small" }, h("p", {}, isAdmin && st.ai ? "No topics yet. Press “Build the manual” above, or add one yourself." : "No topics yet.")));
    if (!shown.length) return mount(listEl, h("p", { class: "muted small", style: { padding: "8px" } }, "Nothing matches."));
    const groups = new Map();
    for (const t of shown) groups.set(t.product || "General", [...(groups.get(t.product || "General") ?? []), t]);
    mount(listEl, [...groups.entries()].map(([product, ts]) => h("div", { class: "manual-group" },
      h("div", { class: "nav-label" }, product),
      ts.map((t) => h("a", { class: "manual-item" + (t.id === id ? " active" : ""), href: `/manual/${t.id}`, "data-link": "" },
        h("div", { class: "manual-item-title" }, t.title),
        h("div", { class: "small muted row", style: { gap: "6px" } },
          t.status === "draft" ? h("span", { class: "badge warn plain" }, "Draft") : null,
          `${t.cases} case${t.cases === 1 ? "" : "s"}`, t.media ? ` · ${t.media} photo${t.media === 1 ? "" : "s"}/video${t.media === 1 ? "" : "s"}` : ""))))));
  }

  function drawEmptyDetail() {
    mount(detailEl, h("div", { class: "card manual-empty" },
      h("h2", {}, "How it works"),
      h("ol", {},
        h("li", {}, "AI reads finished repair conversations — what the customer reported, the photos they sent, and how you answered."),
        h("li", {}, "Similar problems on the same machine are grouped into one topic: symptoms, likely causes, how to fix it, parts & tools."),
        h("li", {}, "Every conversation is kept as a case on its topic, with its photos and videos, so the record grows as repairs come in."),
        h("li", {}, "New topics start as drafts. Edit anything, then publish — published topics also guide AI reply drafts."))));
  }

  // ---- One topic
  async function openTopic(tid) {
    mount(detailEl, h("div", { class: "card" }, skeletonRows(6)));
    let d;
    try {
      d = await api(`/manual/${tid}`);
    } catch (e) {
      return mount(detailEl, h("div", { class: "notice bad" }, e.message));
    }
    drawTopic(d);
  }

  function drawTopic({ topic: t, cases, media }, editing = false) {
    const reload = () => openTopic(t.id);
    const refreshList = async () => { st.topics = (await api("/manual")).topics; drawList(); };
    const save = (patch) => api(`/manual/${t.id}`, { method: "PUT", body: patch });
    const publish = h("button", { class: "btn sm" + (t.status === "draft" ? " primary" : "") }, t.status === "draft" ? "Publish" : "Unpublish");
    publish.onclick = busy(publish, async () => { await save({ status: t.status === "draft" ? "published" : "draft" }); toast(t.status === "draft" ? "Published" : "Moved back to drafts"); await refreshList(); reload(); });
    const aiBox = h("input", { type: "checkbox", checked: !!t.use_in_ai });
    aiBox.onchange = async () => { await save({ use_in_ai: aiBox.checked }); toast(aiBox.checked ? "AI replies will use this topic once it's published" : "AI replies won't use this topic"); };
    const more = h("button", { class: "btn sm ghost icon-only", "aria-label": "More", title: "Merge or delete" }, icon("dots"));
    more.onclick = () => {
      const others = st.topics.filter((x) => x.id !== t.id);
      const pick = h("select", { class: "input" }, others.map((x) => h("option", { value: x.id }, `${x.product ? `${x.product} — ` : ""}${x.title}`)));
      const mergeBtn = h("button", { class: "btn primary" }, "Merge");
      const del = h("button", { class: "btn danger" }, icon("trash"), "Delete topic");
      const dlg = modal("Merge or delete", h("div", { class: "stack" },
        others.length ? h("div", { class: "stack", style: { gap: "8px" } },
          h("b", {}, "Merge into another topic"),
          h("p", { class: "small muted", style: { margin: 0 } }, "Moves this topic's cases, photos and videos there and removes this one. The next update rewrites the combined topic."),
          pick, h("div", {}, mergeBtn)) : null,
        isAdmin ? h("div", { class: "stack", style: { gap: "8px", borderTop: "1px solid var(--border)", paddingTop: "14px" } },
          h("b", {}, "Delete"),
          h("p", { class: "small muted", style: { margin: 0 } }, "Its conversations will be read again on the next update, so they can land in a better topic."),
          h("div", {}, del)) : null), { width: 520 });
      mergeBtn.onclick = busy(mergeBtn, async () => { await api(`/manual/${t.id}/merge`, { method: "POST", body: { into: Number(pick.value) } }); dlg?.close?.(); document.querySelector(".modal")?.remove(); await refreshList(); history.pushState(null, "", `/manual/${pick.value}`); openTopic(Number(pick.value)); });
      del.onclick = busy(del, async () => {
        if (!confirm(`Delete “${t.title}”?`)) return;
        await api(`/manual/${t.id}`, { method: "DELETE" });
        document.querySelector(".modal")?.remove();
        await refreshList();
        history.pushState(null, "", "/manual");
        drawEmptyDetail();
      });
    };

    let body;
    if (editing) {
      const title = h("input", { class: "input", value: t.title });
      const product = h("input", { class: "input", value: t.product, placeholder: "e.g. AK-I Cut Pile Tufting Gun" });
      const summary = h("input", { class: "input", value: t.summary });
      const text = growInput({ value: t.body, rows: 16, style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: "13px", minHeight: "320px" } });
      const saveBtn = h("button", { class: "btn primary" }, "Save");
      saveBtn.onclick = busy(saveBtn, async () => {
        await save({ title: title.value, product: product.value, summary: summary.value, body: text.value });
        toast("Saved — future AI updates keep your wording");
        await refreshList();
        reload();
      });
      body = h("div", { class: "stack" },
        h("div", { class: "grid2" }, h("label", { class: "field" }, "Title", title), h("label", { class: "field" }, "Machine / product", product)),
        h("label", { class: "field" }, "Summary", summary),
        h("label", { class: "field" }, h("span", {}, "Write-up ", h("span", { class: "muted" }, "(Markdown: ## heading, 1. step, - bullet, **bold**)")), text),
        h("div", { class: "row" }, saveBtn, h("button", { class: "btn", onclick: () => drawTopic({ topic: t, cases, media }) }, "Cancel")));
    } else {
      body = t.body ? h("div", { class: "manual-body" }) : h("p", { class: "muted" }, "No write-up yet.");
      if (t.body) body.innerHTML = markdown(t.body);
    }

    const mediaEl = media.length ? h("section", { class: "manual-section" },
      h("h3", {}, `Photos & videos · ${media.length}`),
      h("div", { class: "manual-media" }, media.map((m) => {
        const isVideo = /^video\//.test(m.mime);
        const view = isVideo
          ? h("video", { src: mediaUrl(m), controls: true, preload: "metadata", playsinline: true })
          : h("img", { src: mediaUrl(m), alt: m.caption || m.filename, loading: "lazy", onclick: () => modal(m.caption || m.filename, h("img", { src: mediaUrl(m), alt: "", style: { width: "100%", borderRadius: "8px" } }), { width: 900 }) });
        const cap = h("input", { class: "input caption", value: m.caption, placeholder: "Caption", "aria-label": "Caption" });
        cap.onchange = () => api(`/manual/${t.id}/media/${m.id}`, { method: "PUT", body: { caption: cap.value } }).then(() => toast("Caption saved")).catch((e) => toast(e.message, true));
        return h("figure", {},
          view,
          h("figcaption", {}, cap,
            h("div", { class: "row small", style: { gap: "8px", justifyContent: "space-between" } },
              h("a", { href: `/tickets/${m.ticket_id}`, "data-link": "", class: "muted" }, "From ticket"),
              h("button", { class: "linkish small", onclick: async () => { await api(`/manual/${t.id}/media/${m.id}`, { method: "DELETE" }); reload(); } }, "Remove"))));
      }))) : null;

    const casesEl = h("section", { class: "manual-section" },
      h("h3", {}, `Repair record · ${cases.length} case${cases.length === 1 ? "" : "s"}`),
      cases.length ? h("div", { class: "manual-cases" }, cases.map((x) => h("a", { class: "manual-case", href: `/tickets/${x.ticket_id}`, "data-link": "" },
        h("span", { class: "small muted nowrap" }, shortDate(x.happened_at)),
        h("div", { style: { minWidth: 0 } }, h("div", {}, x.summary || x.subject), h("div", { class: "small muted" }, x.customer_name || x.customer_email)),
        x.outcome ? h("span", { class: "badge plain" }, x.outcome) : null))) : h("p", { class: "muted small" }, "No cases yet."));

    mount(detailEl, h("article", { class: "card manual-topic" },
      h("a", { class: "manual-back small", href: "/manual", "data-link": "" }, icon("back"), "All topics"),
      h("div", { class: "row", style: { justifyContent: "space-between", alignItems: "flex-start", gap: "12px" } },
        h("div", { style: { minWidth: 0 } },
          t.product ? h("div", { class: "lbl-product" }, t.product) : null,
          h("h2", { class: "manual-title" }, t.title,
            h("span", { class: `badge ${t.status === "draft" ? "warn" : "good"}` }, t.status === "draft" ? "Draft" : "Published")),
          t.summary ? h("p", { class: "muted", style: { margin: "4px 0 0" } }, t.summary) : null),
        editing ? null : h("div", { class: "row", style: { gap: "6px", flexWrap: "nowrap" } },
          h("button", { class: "btn sm", onclick: () => drawTopic({ topic: t, cases, media }, true) }, icon("edit"), "Edit"),
          publish, more)),
      editing ? null : h("label", { class: "check small", style: { margin: "10px 0 4px" } }, aiBox, "Use in AI reply drafts when published"),
      h("div", { class: "small muted" }, `Updated ${shortDate(t.updated_at)}${t.edited_at ? " · edited by your team" : " · written by AI"}`),
      h("div", { style: { marginTop: "14px" } }, body),
      mediaEl,
      casesEl));
  }

  async function newTopic() {
    const title = prompt("Topic title (e.g. “Gun jams after a few stitches”)");
    if (!title?.trim()) return;
    const product = prompt("Machine or product (optional)") ?? "";
    const r = await api("/manual", { method: "POST", body: { title, product } });
    st.topics = (await api("/manual")).topics;
    history.pushState(null, "", `/manual/${r.id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }

  load();
  return () => {};
}
