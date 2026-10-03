// Knowledge base (Repair manual → Knowledge base): customer-facing articles. Edit them here, review
// what the AI picked up from support conversations, and publish to the store's Knowledge Base blog,
// where each article is its own page for search engines and AI assistants. The chat and AI
// drafts use them too.
import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, icon, toast, busy, skeletonRows, relTime, spinner } from "./ui.js";
import { photoData } from "./chat-agent.js";

const job = { running: false, stop: false, kind: null, done: 0, onUpdate: null };

export function manualTabs(active) {
  return h("div", { class: "view-chips", role: "tablist" },
    h("a", { class: "view-chip" + (active === "repairs" ? " active" : ""), href: "/manual", "data-link": "", role: "tab", "aria-selected": String(active === "repairs") }, "Repair topics"),
    h("a", { class: "view-chip" + (active === "kb" ? " active" : ""), href: "/manual/kb", "data-link": "", role: "tab", "aria-selected": String(active === "kb") }, "Knowledge base"));
}

/** Topics and articles out of the old knowledge-base HTML file (read in the browser). */
function parseKbFile(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const topics = [...doc.querySelectorAll(".topic-group")].map((g) => ({
    id: g.id.replace(/^nav-/, ""),
    name: g.querySelector(".topic-name")?.textContent.trim() ?? g.id,
    icon: g.querySelector(".topic-icon")?.textContent.trim() ?? "",
  }));
  const articles = [...doc.querySelectorAll("article.article-panel, article[id^='panel-']")].map((a) => ({
    id: a.id.replace(/^panel-/, ""),
    topic_id: a.dataset.topic,
    title: (a.querySelector(".article-title, h1")?.textContent ?? "").trim(),
    html: (a.querySelector(".article-body") ?? a).innerHTML,
  })).filter((a) => a.title && a.topic_id);
  if (!topics.length || !articles.length) throw new Error("That file doesn't look like the knowledge base export (no topics or articles found)");
  return { topics, articles };
}

export function renderKb(main) {
  const isAdmin = state.me.role === "admin";
  const parts = location.pathname.split("/");
  const sel = parts[3] ? decodeURIComponent(parts[3]) : null; // article id or "suggestions"
  const st = { topics: [], articles: [], suggestions: 0, toScan: 0, unsynced: 0, ai: false, q: "" };
  const statusEl = h("div");
  const listEl = h("div", { class: "manual-list" }, skeletonRows(6));
  const detailEl = h("div", { class: "manual-detail" });
  const search = h("input", { class: "input", type: "search", placeholder: "Search articles", "aria-label": "Search the knowledge base" });
  search.oninput = () => { st.q = search.value.trim().toLowerCase(); drawList(); };
  const newBtn = h("button", { class: "btn sm", onclick: newArticle }, icon("plus"), "New article");
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner" },
      h("div", { class: "row", style: { justifyContent: "space-between", flexWrap: "wrap", gap: "10px" } },
        h("div", {}, h("h1", {}, "Repair manual"), h("p", { class: "sub" }, "Knowledge base: the how-tos and fixes customers read on your store. The chat and AI replies use them too.")),
        h("div", { class: "row" }, manualTabs("kb"), newBtn)))),
    h("div", { class: "page-inner wide" }, statusEl,
      h("div", { class: "manual-layout" + (sel ? " has-topic" : "") },
        h("div", { class: "manual-side" }, h("div", { class: "search" }, icon("search"), search), listEl),
        detailEl))));

  async function load() {
    try {
      Object.assign(st, await api("/kb"));
    } catch (e) {
      return mount(listEl, h("div", { class: "notice bad" }, e.message));
    }
    drawStatus();
    drawList();
    if (sel === "suggestions") openSuggestions();
    else if (sel) openArticle(sel);
    else drawEmpty();
  }

  // ---- Status: import, updates from tickets, publish to the store
  function drawStatus() {
    if (!isAdmin) return mount(statusEl);
    if (!st.articles.length) {
      const file = h("input", { type: "file", accept: ".html,text/html", hidden: true });
      const pick = h("button", { class: "btn primary sm" }, icon("download"), "Import knowledge base file");
      pick.onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files?.[0];
        if (!f) return;
        pick.disabled = true;
        pick.replaceChildren(spinner(), "Importing…");
        try {
          const data = parseKbFile(await f.text());
          const r = await api("/kb/import", { method: "POST", body: data });
          toast(`Imported ${r.articles} articles in ${r.topics} topics`);
          await load();
        } catch (e) {
          toast(e.message, true);
          pick.disabled = false;
          pick.replaceChildren(icon("download"), "Import knowledge base file");
        }
      };
      return mount(statusEl, h("div", { class: "card manual-status" },
        h("div", { style: { flex: 1, minWidth: 0 } }, h("b", {}, "Bring in your knowledge base"),
          h("div", { class: "small muted" }, "Pick the knowledge-base HTML file (the one your store page shows now). Its topics, articles and photos come in as they are, ready to edit.")),
        pick, file));
    }
    const running = job.running;
    const scan = h("button", { class: "btn sm" }, icon("spark"), "Find updates in tickets");
    scan.onclick = () => runJob("scan");
    const publish = h("button", { class: "btn sm" + (st.unsynced ? " primary" : "") }, icon("ext"), st.unsynced ? `Publish ${st.unsynced} to store` : "Published");
    publish.disabled = !st.unsynced;
    publish.onclick = () => runJob("publish");
    const stop = h("button", { class: "btn sm", onclick: () => { job.stop = true; stop.disabled = true; } }, "Stop");
    mount(statusEl, h("div", { class: "card manual-status" },
      h("div", { style: { flex: 1, minWidth: 0 } },
        running
          ? h("div", { class: "row", style: { gap: "8px" } }, spinner(), h("b", {}, job.kind === "scan" ? `Reading support conversations… ${job.done} read` : `Publishing to the store… ${job.done} done`))
          : h("b", {}, st.suggestions ? `${st.suggestions} suggested update${st.suggestions === 1 ? "" : "s"} from support conversations` : "Knowledge base"),
        h("div", { class: "small muted" },
          `${st.articles.length} articles · ${st.articles.filter((a) => a.status === "published").length} published`,
          st.ai ? ` · ${st.toScan} finished conversation${st.toScan === 1 ? "" : "s"} not read yet` : "",
          " · Each published article is a page on your store under /blogs/knowledge-base.")),
      running ? stop : [st.ai && st.toScan ? scan : null, publish]));
  }

  async function runJob(kind) {
    if (job.running) return;
    Object.assign(job, { running: true, stop: false, kind, done: 0 });
    drawStatus();
    try {
      while (!job.stop) {
        const r = kind === "scan" ? await api("/kb/scan", { method: "POST", body: { size: 6 } }) : await api("/kb/publish", { method: "POST" });
        job.done += kind === "scan" ? r.read : r.published;
        if (kind === "scan") st.toScan = r.remaining;
        else st.unsynced = r.remaining;
        if (listEl.isConnected) drawStatus();
        if (!r.remaining || !(kind === "scan" ? r.read : r.published)) break;
      }
      toast(kind === "scan" ? "Finished reading — check the suggestions" : "The store's knowledge base is up to date");
    } catch (e) {
      const scope = /access denied|write_content|scope/i.test(e.message);
      toast(scope ? "Shopify said no: the app needs the write_content scope (Shopify admin → Apps → your app → Configuration). Then try again." : e.message, true);
    } finally {
      job.running = false;
      if (listEl.isConnected) await load();
    }
  }

  // ---- Article list, grouped by topic
  function drawList() {
    const q = st.q;
    const shown = st.articles.filter((a) => !q || `${a.title} ${a.id}`.toLowerCase().includes(q));
    const items = [];
    if (st.suggestions) {
      items.push(h("a", { class: "manual-item kb-sugg" + (sel === "suggestions" ? " active" : ""), href: "/manual/kb/suggestions", "data-link": "" },
        h("span", { class: "manual-item-title" }, icon("spark"), ` ${st.suggestions} suggested update${st.suggestions === 1 ? "" : "s"}`),
        h("span", { class: "small muted" }, "From support conversations")));
    }
    if (!st.articles.length) return mount(listEl, ...items, h("p", { class: "muted small", style: { padding: "8px" } }, "No articles yet."));
    for (const t of st.topics) {
      const as = shown.filter((a) => a.topic_id === t.id);
      if (!as.length) continue;
      items.push(h("div", { class: "manual-group" },
        h("div", { class: "nav-label" }, `${t.icon} ${t.name}`),
        as.map((a) => h("a", { class: "manual-item" + (a.id === sel ? " active" : ""), href: `/manual/kb/${encodeURIComponent(a.id)}`, "data-link": "" },
          h("span", { class: "manual-item-title" }, a.title),
          h("span", { class: "small muted" },
            a.status === "draft" ? h("span", { class: "badge warn plain" }, "Draft") : null,
            a.status === "published" && (!a.synced_at || a.updated_at > a.synced_at) ? h("span", { class: "badge plain" }, "Not on store yet") : null,
            ` ${a.words} words`)))));
    }
    mount(listEl, ...items);
  }

  function drawEmpty() {
    mount(detailEl, h("div", { class: "card empty" },
      h("h2", {}, "Knowledge base"),
      h("p", { class: "muted" }, "Pick an article to read or edit it. Published articles go to your store as their own pages (with the title and description search engines show), and the website chat links customers to them."),
      st.suggestions ? h("a", { class: "btn", href: "/manual/kb/suggestions", "data-link": "" }, icon("spark"), `Review ${st.suggestions} suggested update${st.suggestions === 1 ? "" : "s"}`) : null));
  }

  // ---- Editor
  async function openArticle(id) {
    mount(detailEl, h("div", { class: "card" }, skeletonRows(6)));
    let a;
    try {
      ({ article: a } = await api(`/kb/article/${encodeURIComponent(id)}`));
    } catch (e) {
      return mount(detailEl, h("div", { class: "notice bad" }, e.message));
    }
    const dirty = { v: false };
    const save = h("button", { class: "btn save-btn" }, "Save");
    const mark = () => { dirty.v = true; save.classList.add("primary"); };
    const title = h("input", { class: "input kb-title", value: a.title, "aria-label": "Title", oninput: mark });
    const topic = h("select", { class: "input", "aria-label": "Topic", onchange: mark }, st.topics.map((t) => h("option", { value: t.id, selected: t.id === a.topic_id }, `${t.icon} ${t.name}`)));
    const status = h("select", { class: "input", "aria-label": "Status", onchange: mark }, [["published", "Published"], ["draft", "Draft"]].map(([v, t]) => h("option", { value: v, selected: a.status === v }, t)));
    const useAi = h("input", { type: "checkbox", checked: !!a.use_in_ai, onchange: mark });
    const { el: editor, body } = articleEditor(a.body_html, mark);
    const desc = h("textarea", { class: "input", rows: 2, maxlength: 300, placeholder: a.autoDescription, oninput: () => { mark(); count(); } });
    desc.value = a.description || "";
    const counter = h("span", { class: "small muted" });
    const count = () => { const n = (desc.value || a.autoDescription).length; counter.textContent = `${n} characters${n > 160 ? " — search results cut off around 155" : ""}`; };
    count();
    save.onclick = busy(save, async () => {
      const r = await api(`/kb/article/${encodeURIComponent(a.id)}`, { method: "PUT", body: {
        title: title.value, topic_id: topic.value, status: status.value, use_in_ai: useAi.checked, description: desc.value, body_html: body.innerHTML,
      } });
      dirty.v = false;
      save.classList.remove("primary");
      st.unsynced = r.unsynced;
      toast(status.value === "published" ? "Saved — press “Publish to store” to update the store" : "Saved as a draft");
      Object.assign(st, await api("/kb"));
      drawStatus();
      drawList();
    });
    const del = isAdmin ? h("button", { class: "btn sm ghost danger" }, "Delete") : null;
    if (del) del.onclick = busy(del, async () => {
      if (!confirm(`Delete “${a.title}”?${a.shopify_id ? " It's removed from the store too." : ""}`)) return;
      await api(`/kb/article/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      toast("Deleted");
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    });
    addEventListener("beforeunload", (e) => { if (dirty.v && detailEl.isConnected) e.preventDefault(); }, { once: true });
    mount(detailEl, h("div", { class: "card kb-edit" },
      h("a", { class: "btn ghost sm back-btn kb-back", href: "/manual/kb", "data-link": "" }, icon("back"), "All articles"),
      title,
      h("div", { class: "row kb-meta", style: { gap: "10px", flexWrap: "wrap" } },
        topic, status, h("label", { class: "check" }, useAi, "Use in chat & AI replies"),
        h("span", { style: { flex: 1 } }),
        a.url ? h("a", { class: "btn sm ghost", href: a.url, target: "_blank", rel: "noopener" }, icon("ext"), "View on store") : h("span", { class: "small muted" }, "Not on the store yet"),
        a.updated_at ? h("span", { class: "small muted" }, `edited ${relTime(a.updated_at)}`) : null),
      editor,
      h("label", { class: "field", style: { marginTop: "14px" } }, "Search description (what Google and AI assistants show)", desc, counter),
      h("div", { class: "row", style: { marginTop: "14px" } }, save, h("span", { style: { flex: 1 } }), del)));
  }

  async function newArticle() {
    if (!st.topics.length) return toast("Import the knowledge base first", true);
    const t = prompt("Title of the new article (write it the way a customer would ask, e.g. “How do I fix a jammed AK-I?”)");
    if (!t?.trim()) return;
    const topicId = st.topics.find((x) => x.id === "troubleshoot")?.id ?? st.topics[0].id;
    const r = await api("/kb/article", { method: "POST", body: { title: t, topic_id: topicId } });
    history.pushState(null, "", `/manual/kb/${encodeURIComponent(r.id)}`);
    renderKb(main);
  }

  // ---- Suggestions from support conversations
  async function openSuggestions() {
    mount(detailEl, h("div", { class: "card" }, skeletonRows(5)));
    const { suggestions } = await api("/kb/suggestions");
    if (!suggestions.length) return mount(detailEl, h("div", { class: "card empty" }, h("p", {}, "No suggestions waiting.")));
    mount(detailEl, h("div", { class: "stack", style: { gap: "14px" } },
      h("p", { class: "muted", style: { margin: 0 } }, "What the AI noticed in finished support conversations that the knowledge base doesn't cover yet. Edit before accepting if you like — accepted additions go into the article (new articles start as drafts)."),
      suggestions.map((s) => suggestionCard(s))));
  }

  function suggestionCard(s) {
    const target = h("select", { class: "input" },
      h("option", { value: "", selected: !s.article_id }, "New article (draft)"),
      st.articles.map((a) => h("option", { value: a.id, selected: a.id === s.article_id }, `Add to: ${a.title}`)));
    const title = h("input", { class: "input", value: s.title, "aria-label": "Heading" });
    const { el: editor, body } = articleEditor(s.content_html, () => {}, true);
    const card = h("div", { class: "card kb-sugg-card" });
    const accept = h("button", { class: "btn primary sm" }, icon("check"), "Accept");
    accept.onclick = busy(accept, async () => {
      const r = await api(`/kb/suggestions/${s.id}/accept`, { method: "POST", body: { title: title.value, content_html: body.innerHTML, article_id: target.value || null } });
      toast(target.value ? "Added to the article" : "New draft article created");
      card.remove();
      Object.assign(st, await api("/kb"));
      drawStatus();
      drawList();
      if (!target.value) { history.pushState(null, "", `/manual/kb/${encodeURIComponent(r.articleId)}`); renderKb(main); }
    });
    const dismiss = h("button", { class: "btn sm ghost" }, "Dismiss");
    dismiss.onclick = busy(dismiss, async () => {
      await api(`/kb/suggestions/${s.id}/dismiss`, { method: "POST" });
      card.remove();
      st.suggestions = Math.max(0, st.suggestions - 1);
      drawStatus();
      drawList();
    });
    mount(card,
      h("div", { class: "small muted" }, icon("spark"), " ", s.reason,
        s.ticket_ids.length ? [" · from ", s.ticket_ids.map((id, i) => [i ? ", " : "", h("a", { href: `/tickets/${id}`, "data-link": "" }, `#${id}`)])] : null),
      h("div", { class: "grid2", style: { marginTop: "10px" } }, target, title),
      editor,
      h("div", { class: "row", style: { marginTop: "10px", gap: "8px" } }, accept, dismiss));
    return card;
  }

  load();
  return () => {};
}

/** A small rich-text editor for articles: headings, bold/italic, lists, links and photos. */
function articleEditor(html, onChange, compact = false) {
  const body = h("div", { class: "rte kb-body" + (compact ? " compact" : ""), contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Article" });
  body.innerHTML = html || "<p></p>";
  body.addEventListener("input", onChange);
  body.addEventListener("paste", (e) => {
    const text = e.clipboardData.getData("text/plain");
    if (e.clipboardData.getData("text/html")) return; // keep simple formatting; the server cleans it
    e.preventDefault();
    document.execCommand("insertText", false, text);
  });
  const cmd = (name, arg) => () => { body.focus(); document.execCommand(name, false, arg); onChange(); };
  const tb = (content, label, fn) => h("button", { class: "tb", type: "button", title: label, "aria-label": label, onmousedown: (e) => e.preventDefault(), onclick: fn }, content);
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  file.onchange = async () => {
    const f = file.files?.[0];
    file.value = "";
    if (!f) return;
    try {
      const p = await photoData(f);
      const { url } = await api("/kb/image", { method: "POST", body: { mime: p.mime, data: p.data } });
      const alt = (prompt("Describe the photo (for search engines and screen readers)") || "").replace(/"/g, "'");
      body.focus();
      document.execCommand("insertHTML", false, `<p><img src="${url}" alt="${alt}"></p>`);
      onChange();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const link = () => {
    const url = prompt("Link address (https://… or #article-id for another article)");
    if (url && /^(https?:|mailto:|#|\/)/i.test(url.trim())) cmd("createLink", url.trim())();
  };
  const bar = h("div", { class: "rte-bar", role: "toolbar", "aria-label": "Formatting" },
    tb(h("b", { class: "tb-txt" }, "H2"), "Heading", cmd("formatBlock", "h3")),
    tb(h("b", { class: "tb-txt" }, "H3"), "Subheading", cmd("formatBlock", "h4")),
    tb(h("span", { class: "tb-txt" }, "¶"), "Paragraph", cmd("formatBlock", "p")), h("span", { class: "sep" }),
    tb(icon("bold"), "Bold", cmd("bold")), tb(icon("italic"), "Italic", cmd("italic")), h("span", { class: "sep" }),
    tb(icon("ul"), "Bulleted list", cmd("insertUnorderedList")), tb(icon("ol"), "Numbered list", cmd("insertOrderedList")),
    tb(icon("link"), "Link", link), tb(icon("image"), "Photo", () => file.click()), tb(icon("eraser"), "Clear formatting", cmd("removeFormat")));
  return { el: h("div", { class: "kb-editor" }, bar, body, file), body };
}
