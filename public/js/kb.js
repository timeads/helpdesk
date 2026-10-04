// Knowledge base (Repair manual → Knowledge base): customer-facing articles. Edit them here, review
// what the AI picked up from support conversations, and publish to the store's Knowledge Base blog,
// where each article is its own page for search engines and AI assistants. The chat and AI
// drafts use them too.
import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, icon, toast, busy, skeletonRows, relTime, spinner, modal } from "./ui.js";
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
      const [k, d, l] = await Promise.all([api("/kb"), api("/kb/duplicates").catch(() => ({ groups: [] })), isAdmin ? api("/kb/links").catch(() => ({ report: null })) : { report: null }]);
      Object.assign(st, k, { dupeGroups: d.groups, dupes: d.groups.length, links: l.report });
    } catch (e) {
      return mount(listEl, h("div", { class: "notice bad" }, e.message));
    }
    drawStatus();
    drawList();
    if (sel === "suggestions") openSuggestions();
    else if (sel === "duplicates") openDuplicates();
    else if (sel === "questions") openQuestions();
    else if (sel === "links") openLinks();
    else if (sel) openArticle(sel);
    else drawEmpty();
    // A job asked for from another view (e.g. “Merge with AI” on the suggestions page)
    if (job.next && !job.running) { const k = job.next; job.next = null; runJob(k); }
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
    const dupes = h("button", { class: "btn sm" }, icon("merge"), "Find duplicates");
    dupes.onclick = busy(dupes, async () => {
      dupes.replaceChildren(spinner(), "Comparing articles…");
      const r = await api("/kb/duplicates/find", { method: "POST" });
      toast(r.groups.length ? `Found ${r.groups.length} set${r.groups.length === 1 ? "" : "s"} of duplicates — review them before merging` : "No duplicates found");
      if (r.groups.length) { history.pushState(null, "", "/manual/kb/duplicates"); renderKb(main); }
      else dupes.replaceChildren(icon("merge"), "Find duplicates");
    });
    const restyle = h("button", { class: "btn sm", title: "Your older posts with tables still show the old plain tables on the store. This republishes just those posts so their tables get the new style. Their text doesn't change." }, icon("ext"), `Apply new table style to ${st.restyle} post${st.restyle === 1 ? "" : "s"}`);
    restyle.onclick = busy(restyle, async () => {
      await api("/kb/restyle", { method: "POST" });
      st.restyle = 0;
      await runJob("publish");
    });
    const linksBtn = h("button", { class: "btn sm", title: "Checks every link in every article against your store's products, pages and blog posts" }, icon("search"), "Check links");
    linksBtn.onclick = busy(linksBtn, async () => {
      linksBtn.replaceChildren(spinner(), "Checking links…");
      const r = await api("/kb/links/check", { method: "POST" });
      st.links = r.report;
      toast(r.report.issues.length ? `${r.report.issues.length} link${r.report.issues.length === 1 ? "" : "s"} to fix (of ${r.report.links} checked)` : `All ${r.report.links} store links are good`);
      history.pushState(null, "", "/manual/kb/links");
      renderKb(main);
    });
    const pull = h("button", { class: "btn sm" }, icon("download"), "Update from store");
    pull.onclick = () => pullDialog();
    const auto = h("input", { type: "checkbox", checked: !!st.autoMerge });
    auto.onchange = async () => {
      try {
        await api("/kb/auto-merge", { method: "PUT", body: { on: auto.checked } });
        st.autoMerge = auto.checked;
        toast(auto.checked ? "Auto-merge is on: new conversations are read and merged into articles every few minutes. Publish to store when you're ready." : "Auto-merge is off");
      } catch (e) {
        auto.checked = !auto.checked;
        toast(e.message, true);
      }
    };
    const autoLabel = st.ai ? h("label", { class: "check small", title: "Reads newly closed conversations and merges what they teach into the right articles with AI, by itself" }, auto, "Auto-merge new conversations") : null;
    mount(statusEl, h("div", { class: "card manual-status" },
      h("div", { style: { flex: 1, minWidth: 0 } },
        running
          ? h("div", { class: "row", style: { gap: "8px" } }, spinner(), h("b", {}, job.kind === "scan" ? `Reading support conversations… ${job.done} read` : job.kind === "merge" ? `Merging suggestions into articles… ${job.done} done` : job.kind === "dupes" ? `Merging duplicates… ${job.done} done` : `Publishing to the store… ${job.done} done`))
          : h("b", {}, st.suggestions ? `${st.suggestions} suggested update${st.suggestions === 1 ? "" : "s"} from support conversations` : "Knowledge base"),
        h("div", { class: "small muted" },
          `${st.articles.length} articles · ${st.articles.filter((a) => a.status === "published").length} published`,
          st.ai ? ` · ${st.toScan} finished conversation${st.toScan === 1 ? "" : "s"} not read yet` : "",
          " · Each published article is a page on your store under /blogs/knowledge-base.")),
      running ? stop : h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" } },
        autoLabel, st.ai && st.toScan ? scan : null, st.ai && st.articles.length > 1 ? dupes : null, st.articles.length ? linksBtn : null, pull, st.restyle && !st.unsynced ? restyle : null, publish)));
  }

  async function runJob(kind) {
    if (job.running) return;
    Object.assign(job, { running: true, stop: false, kind, done: 0 });
    drawStatus();
    try {
      while (!job.stop) {
        const r = kind === "scan" ? await api("/kb/scan", { method: "POST", body: { size: 6 } })
          : kind === "merge" ? await api("/kb/integrate", { method: "POST" })
            : await api("/kb/publish", { method: "POST" });
        const step = kind === "scan" ? r.read : kind === "merge" ? r.folded + r.created : r.published;
        job.done += step;
        if (kind === "scan") st.toScan = r.remaining;
        else if (kind === "merge") st.suggestions = r.remaining;
        else st.unsynced = r.remaining;
        if (listEl.isConnected) drawStatus();
        if (!r.remaining || !step) break;
      }
      toast(kind === "scan" ? "Finished reading — check the suggestions" : kind === "merge" ? "Suggestions merged into the articles — review, then publish to the store" : "The store's knowledge base is up to date");
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
    if (st.dupes) {
      items.push(h("a", { class: "manual-item kb-sugg" + (sel === "duplicates" ? " active" : ""), href: "/manual/kb/duplicates", "data-link": "" },
        h("span", { class: "manual-item-title" }, icon("merge"), ` ${st.dupes} set${st.dupes === 1 ? "" : "s"} of duplicates`),
        h("span", { class: "small muted" }, "Review and merge")));
    }
    if (st.links?.issues.length) {
      items.push(h("a", { class: "manual-item kb-sugg" + (sel === "links" ? " active" : ""), href: "/manual/kb/links", "data-link": "" },
        h("span", { class: "manual-item-title" }, icon("flag"), ` ${st.links.issues.length} link${st.links.issues.length === 1 ? "" : "s"} to fix`),
        h("span", { class: "small muted" }, `Checked ${relTime(st.links.at)}`)));
    }
    if (st.asks) {
      items.push(h("a", { class: "manual-item kb-sugg" + (sel === "questions" ? " active" : ""), href: "/manual/kb/questions", "data-link": "" },
        h("span", { class: "manual-item-title" }, icon("search"), ` ${st.asks} learn hub question${st.asks === 1 ? "" : "s"}`),
        h("span", { class: "small muted" }, "What visitors asked the Ask box · last 30 days")));
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
    // Earlier versions (saved before every edit and AI merge) can be put back
    const versionsEl = h("span");
    api(`/kb/article/${encodeURIComponent(a.id)}/versions`).then(({ versions }) => {
      if (!versions.length || !isAdmin) return;
      const pick = h("select", { class: "input", "aria-label": "Earlier versions", style: { width: "auto" } },
        h("option", { value: "" }, `Earlier versions (${versions.length})`),
        versions.map((v) => h("option", { value: v.id }, `${new Date(v.saved_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${v.reason}`)));
      pick.onchange = async () => {
        if (!pick.value) return;
        const v = versions.find((x) => String(x.id) === pick.value);
        if (!confirm(`Put back the version from ${new Date(v.saved_at).toLocaleString()}? (${v.reason}) The current text is saved as a version too.`)) { pick.value = ""; return; }
        try {
          await api(`/kb/versions/${v.id}/restore`, { method: "POST" });
          toast("Earlier version restored");
          openArticle(a.id);
        } catch (e) {
          toast(e.message, true);
        }
      };
      mount(versionsEl, pick);
    }).catch(() => {});
    mount(detailEl, h("div", { class: "card kb-edit" },
      h("a", { class: "btn ghost sm back-btn kb-back", href: "/manual/kb", "data-link": "" }, icon("back"), "All articles"),
      title,
      h("div", { class: "row kb-meta", style: { gap: "10px", flexWrap: "wrap" } },
        topic, status, h("label", { class: "check" }, useAi, "Use in chat & AI replies"),
        h("span", { style: { flex: 1 } }),
        a.blog_handle && a.blog_handle !== "knowledge-base" ? h("span", { class: "badge plain", title: "This article stays in this blog on the store, at the same address" }, `${a.blog_handle.replace(/-/g, " ")} blog`) : null,
        a.url ? h("a", { class: "btn sm ghost", href: a.url, target: "_blank", rel: "noopener" }, icon("ext"), "View on store") : h("span", { class: "small muted" }, "Not on the store yet"),
        a.updated_at ? h("span", { class: "small muted" }, `edited ${relTime(a.updated_at)}`) : null,
        versionsEl),
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

  // ---- Update from the store: the Knowledge Base blog wins; other blogs can feed the AI
  async function pullDialog() {
    const body = h("div", { class: "stack" }, skeletonRows(3));
    const { close } = modal("Update from your store", body, { width: 640 });
    let data;
    try {
      data = await api("/kb/store-blogs");
    } catch (e) {
      mount(body, h("div", { class: "notice bad" }, e.message));
      return;
    }
    // First time: the Learn-hub blogs are edited here; stories are only read by the AI; press & giving left out
    const LEARN = ["getting-started-with-tufting", "all-about-tufting", "compare-the-machines", "high-pile-machines", "all-about-yarn", "finishing-tufted-pieces",
      "tech-support", "workshop-info", "shipping-info", "returns-and-exchanges", "reflect-rewards", "tufting-residency"];
    const mode = new Map(data.blogs.map((b) => [b.handle,
      b.handle === "knowledge-base" ? "edit"
        : data.configured ? (b.managed ? "edit" : b.aiReads ? "ai" : "off")
          : LEARN.includes(b.handle) ? "edit" : b.handle === "info" || b.aiReads ? "ai" : "off"]));
    const go = h("button", { class: "btn primary" }, icon("download"), "Update now");
    go.onclick = busy(go, async () => {
      go.replaceChildren(spinner(), "Reading your store…");
      const manage = [...mode].filter(([, m]) => m === "edit").map(([hd]) => hd);
      const aiBlogs = [...mode].filter(([, m]) => m === "ai").map(([hd]) => hd);
      const r = await api("/kb/pull", { method: "POST", body: { manage, aiBlogs } });
      close();
      toast([
        `${r.onStore} articles in ${Object.keys(r.blogs ?? {}).length} blog${Object.keys(r.blogs ?? {}).length === 1 ? "" : "s"}`,
        r.updated ? `${r.updated} updated` : null,
        r.added ? `${r.added} added` : null,
        r.removed ? `${r.removed} removed (no longer on the store)` : null,
        r.unchanged ? `${r.unchanged} already the same` : null,
        r.kept ? `${r.kept} kept as in the desk (changes not published yet — publish them first)` : null,
        r.topicsAdded ? `${r.topicsAdded} new topic${r.topicsAdded === 1 ? "" : "s"}` : null,
        r.blogArticles ? `${r.blogArticles} articles for the AI to read` : null,
      ].filter(Boolean).join(" · "));
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    });
    const choice = (b) => {
      if (b.handle === "knowledge-base") return h("span", { class: "small muted" }, "Always edited here");
      const sel = h("select", { class: "input", "aria-label": `${b.title}: how to use it`, style: { width: "auto" } },
        [["edit", "Edit here"], ["ai", "AI reads only"], ["off", "Leave out"]].map(([v, t]) => h("option", { value: v, selected: mode.get(b.handle) === v }, t)));
      sel.onchange = () => mode.set(b.handle, sel.value);
      return sel;
    };
    mount(body,
      h("p", { style: { margin: 0 } }, "Makes the knowledge base here match your store. For each blog edited here: your edits on the store replace the text here, articles added there come in, and ones deleted or merged there are removed here. Articles stay in their own blog with the same address."),
      h("p", { class: "small muted", style: { margin: 0 } }, "Everything that changes is saved as an earlier version first. Drafts you never published are left alone. “AI reads only” blogs stay as they are on the store; the chat and AI replies look things up in them."),
      h("div", { class: "site-list blog-modes" }, data.blogs.map((b) => h("div", { class: "blog-mode" },
        h("span", {}, h("b", {}, b.title), h("span", { class: "small muted" }, ` · ${b.count} article${b.count === 1 ? "" : "s"}`)), choice(b)))),
      h("div", { class: "row" }, go));
  }

  // ---- Link check: fix links that go nowhere, to retired products, through redirects or the old domain
  function openLinks() {
    const r = st.links;
    if (!r) return mount(detailEl, h("div", { class: "card empty" }, h("p", {}, "Use “Check links” above to check every link in every article.")));
    const GROUPS = [
      ["broken", "Broken — these go to a missing page (404)"],
      ["retired", "Retired — the product, page or post is no longer on the store"],
      ["redirect", "Redirected — they work, but link straight to where they end up"],
      ["old-domain", "Old address — tuftinggun.com links that work through a redirect"],
    ];
    const rows = r.issues.map((i) => {
      const pick = h("input", { type: "checkbox", checked: !!i.suggestion, "aria-label": "Fix this link" });
      const to = h("input", { class: "input", value: i.suggestion?.href ?? "", placeholder: "New link, e.g. /products/the-duo", "aria-label": "New link" });
      const remove = h("input", { type: "checkbox" });
      to.oninput = () => { pick.checked = !!to.value.trim() || remove.checked; count(); };
      remove.onchange = () => { to.disabled = remove.checked; pick.checked = remove.checked || !!to.value.trim(); count(); };
      pick.onchange = count;
      const el = h("div", { class: "link-row" },
        h("label", { class: "link-pick" }, pick),
        h("div", { class: "link-main" },
          h("div", {}, h("a", { href: `/manual/kb/${encodeURIComponent(i.articleId)}`, "data-link": "" }, h("b", {}, i.articleTitle)), i.text ? h("span", { class: "muted" }, ` · “${i.text}”`) : null),
          h("div", { class: "small" }, h("code", {}, i.href), h("span", { class: "muted" }, ` — ${i.problem}`)),
          h("div", { class: "row link-fix" }, h("span", { class: "small muted" }, "Change to"), to,
            i.suggestion?.title && i.suggestion.title !== i.suggestion.href ? h("span", { class: "small muted" }, i.suggestion.title) : null,
            h("label", { class: "check small" }, remove, "Remove the link (keep the words)"))));
      return { i, el, pick, to, remove };
    });
    const apply = h("button", { class: "btn primary sm" });
    const count = () => {
      const n = rows.filter((x) => x.pick.checked && (x.remove.checked || x.to.value.trim())).length;
      apply.textContent = n ? `Fix ${n} link${n === 1 ? "" : "s"}` : "Fix links";
      apply.disabled = !n;
    };
    apply.onclick = busy(apply, async () => {
      const fixes = rows.filter((x) => x.pick.checked && (x.remove.checked || x.to.value.trim()))
        .map((x) => ({ articleId: x.i.articleId, href: x.i.href, to: x.remove.checked ? null : x.to.value.trim() }));
      const out = await api("/kb/links/fix", { method: "POST", body: { fixes } });
      toast(`Fixed links in ${out.articles} article${out.articles === 1 ? "" : "s"} — press “Publish to store” to update the site`);
      await load();
    });
    const outside = h("button", { class: "btn sm" }, icon("ext"), r.external.length > r.externalChecked ? `Check ${r.external.length - r.externalChecked} outside links` : "Outside links checked");
    outside.disabled = r.external.length <= r.externalChecked;
    outside.onclick = busy(outside, async () => {
      let found = 0;
      for (;;) {
        outside.replaceChildren(spinner(), "Checking outside links…");
        const x = await api("/kb/links/external", { method: "POST" });
        found += x.found;
        if (!x.remaining || !x.checked) break;
      }
      toast(found ? `${found} outside link${found === 1 ? "" : "s"} go nowhere — listed under Broken` : "All outside links answered");
      await load();
    });
    count();
    mount(detailEl, h("div", { class: "kb-edit" },
      h("div", { class: "card" },
        h("h2", { style: { margin: "0 0 6px" } }, "Link check"),
        h("p", { class: "small muted", style: { margin: "0 0 10px" } },
          `${r.links} links in ${r.articles} articles, checked ${relTime(r.at)} against your store's products, collections, pages and blog posts. `,
          r.issues.length ? "Suggested fixes are filled in — check them, change any you like, then fix. Each article's earlier version is saved, and the fixes go to the site when you publish." : "Every store link goes somewhere real.",
          r.redirectsChecked ? "" : " (Store redirects couldn't be read — add the read_online_store_navigation scope to check those too.)"),
        h("div", { class: "row", style: { gap: "8px", flexWrap: "wrap" } }, r.issues.length ? apply : null, outside)),
      GROUPS.map(([k, title]) => {
        const list = rows.filter((x) => x.i.status === k);
        return list.length ? h("div", { class: "card" }, h("h3", { style: { margin: "0 0 6px" } }, `${title} (${list.length})`), list.map((x) => x.el)) : null;
      })));
  }

  // ---- Learn hub questions: what visitors asked the Ask box, and where an article is missing
  async function openQuestions() {
    mount(detailEl, h("div", { class: "card" }, skeletonRows(4)));
    let d;
    try { d = await api("/kb/asks"); } catch (e) { return mount(detailEl, h("div", { class: "notice bad" }, e.message)); }
    const KIND = { fix: "Fix a problem", buy: "Buying advice", stock: "Restocks", classes: "Classes", general: "General", order: "Their order" };
    const row = (r) => h("div", { class: "ask-row" },
      h("div", { class: "row", style: { justifyContent: "space-between", gap: "8px", flexWrap: "wrap" } },
        h("b", {}, r.question),
        h("span", { class: "small muted" }, [KIND[r.kind] || r.kind, r.machine, relTime(r.created_at), r.helpful === 1 ? "👍" : r.helpful === -1 ? "👎" : null].filter(Boolean).join(" · "))),
      r.answer ? h("details", {}, h("summary", { class: "small muted" }, "Answer given"), h("p", { class: "small" }, r.answer)) : null,
      h("div", { class: "small muted" }, r.articles.length ? ["Cited: ", r.articles.map((a, i) => [i ? ", " : "", h("a", { href: a.url, target: "_blank", rel: "noopener" }, a.title)])] : r.handoff ? "Sent to chat" : "No article matched"));
    const stat = (n, label) => h("div", { class: "ask-stat" }, h("b", {}, String(n)), h("span", { class: "small muted" }, label));
    mount(detailEl, h("div", { class: "kb-edit" },
      h("div", { class: "card" },
        h("h2", { style: { margin: "0 0 6px" } }, "Learn hub questions"),
        h("p", { class: "small muted", style: { margin: "0 0 12px" } }, "Everything visitors asked the Ask box in the last 30 days. Questions no article answered (or that got a thumbs down) are listed first — they're good candidates for a new article."),
        h("div", { class: "ask-stats" }, stat(d.total, "questions"), Object.entries(d.byKind).map(([k, n]) => stat(n, KIND[k] || k)), stat(`${d.helpful} / ${d.unhelpful}`, "👍 / 👎"))),
      d.gaps.length ? h("div", { class: "card" }, h("h3", { style: { margin: "0 0 8px" } }, `Missing or unhelpful answers (${d.gaps.length})`), d.gaps.map(row)) : null,
      h("div", { class: "card" }, h("h3", { style: { margin: "0 0 8px" } }, "Latest questions"), d.recent.length ? d.recent.map(row) : h("p", { class: "muted" }, "No questions yet."))));
  }

  // ---- Duplicates: review the sets the AI found, then merge (one rewritten article per set)
  function openDuplicates() {
    const groups = st.dupeGroups ?? [];
    if (!groups.length) return mount(detailEl, h("div", { class: "card empty" }, h("p", {}, "No duplicates waiting. Use “Find duplicates” above to check again.")));
    const cards = groups.map((g) => dupeCard(g));
    const progress = h("span", { class: "small muted" });
    const all = h("button", { class: "btn primary sm" }, icon("merge"), `Merge all ${groups.length} sets`);
    all.onclick = busy(all, async () => {
      const chosen = cards.filter((c) => c.included());
      if (!chosen.length) return toast("Nothing ticked to merge", true);
      if (!confirm(`Merge ${chosen.length} set${chosen.length === 1 ? "" : "s"} of articles? Each set becomes one article; the others are removed (their old text is kept as an earlier version you can restore).`)) return;
      let done = 0;
      for (const c of chosen) {
        progress.textContent = `Merging ${done + 1} of ${chosen.length}… (about half a minute each)`;
        try {
          await c.merge();
          done++;
        } catch (e) {
          toast(`${c.title()}: ${e.message}`, true);
        }
      }
      toast(`Merged ${done} set${done === 1 ? "" : "s"} — review the articles, then publish to the store`);
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    });
    mount(detailEl, h("div", { class: "stack", style: { gap: "14px" } },
      h("div", { class: "card kb-bulk" },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("b", {}, `${groups.length} set${groups.length === 1 ? "" : "s"} of articles that cover the same thing`),
          h("div", { class: "small muted" }, "Untick any set you'd rather keep apart, and pick which article to keep in each (its address stays the same). The AI writes one article from each set without repeating anything; photos and links are kept."),
          progress),
        isAdmin ? all : null),
      cards.map((c) => c.el)));
  }

  function dupeCard(g) {
    let keep = g.keep;
    const include = h("input", { type: "checkbox", checked: true, "aria-label": "Merge this set" });
    const title = h("input", { class: "input", value: g.title || g.articles[0].title, "aria-label": "Title of the merged article" });
    const name = `keep-${g.keep}`;
    const rows = g.articles.map((a) => {
      const r = h("input", { type: "radio", name, checked: a.id === keep, "aria-label": `Keep ${a.title}` });
      r.onchange = () => (keep = a.id);
      return h("div", { class: "dupe-row" }, h("label", { class: "check" }, r, h("span", {}, h("a", { href: `/manual/kb/${encodeURIComponent(a.id)}`, target: "_blank" }, a.title))),
        h("span", { class: "small muted" }, `${a.words} words`, a.status === "draft" ? " · draft" : "", a.onStore ? " · on the store" : ""));
    });
    const go = h("button", { class: "btn sm" }, icon("merge"), "Merge this set");
    const el = h("div", { class: "card kb-sugg-card" },
      h("div", { class: "row", style: { gap: "8px" } }, h("label", { class: "check" }, include, h("b", {}, g.reason || "Same subject"))),
      h("div", { class: "small muted", style: { margin: "4px 0 2px" } }, "Keep (the others fold into it):"),
      rows,
      h("label", { class: "field", style: { marginTop: "8px" } }, "Title of the merged article", title),
      isAdmin ? h("div", { class: "row", style: { marginTop: "8px" } }, go) : null);
    const merge = async () => {
      await api("/kb/duplicates/merge", { method: "POST", body: { keep, merge: g.articles.map((a) => a.id).filter((id) => id !== keep), title: title.value } });
      el.remove();
    };
    go.onclick = busy(go, async () => {
      go.replaceChildren(spinner(), "Merging…");
      await merge();
      toast("Merged into one article");
      Object.assign(st, await api("/kb"));
      st.dupeGroups = st.dupeGroups.filter((x) => x !== g);
      st.dupes = st.dupeGroups.length;
      drawList();
    });
    return { el, merge, included: () => include.checked && el.isConnected, title: () => title.value };
  }

  // ---- Suggestions from support conversations
  async function openSuggestions() {
    mount(detailEl, h("div", { class: "card" }, skeletonRows(5)));
    const { suggestions } = await api("/kb/suggestions");
    if (!suggestions.length) return mount(detailEl, h("div", { class: "card empty" }, h("p", {}, "No suggestions waiting.")));
    edited.clear();
    const total = Math.max(st.suggestions, suggestions.length);
    const progress = h("span", { class: "small muted" });
    const all = h("button", { class: "btn sm" }, icon("check"), `Add all ${total} as written`);
    all.onclick = busy(all, async () => {
      if (!confirm(`Accept all ${total} suggestions? Additions go into their articles; new articles are created as drafts for you to review before publishing.`)) return;
      let done = 0;
      const failed = [];
      for (;;) {
        const r = await api("/kb/suggestions/accept-all", { method: "POST", body: { edits: Object.fromEntries(edited) } });
        done += r.accepted;
        failed.push(...r.failed);
        progress.textContent = `Accepted ${done}…`;
        if (!r.remaining || !(r.accepted + r.failed.length)) break;
      }
      toast(failed.length ? `Accepted ${done}; ${failed.length} couldn't be added (${failed[0]}) and were set aside` : `Accepted ${done} suggestions — press “Publish to store” when you're ready`, !!failed.length);
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    });
    const mergeAi = h("button", { class: "btn primary sm" }, icon("spark"), "Merge with AI");
    mergeAi.title = "Works each suggestion into the article it belongs in, rewriting so nothing is repeated; new subjects become draft articles";
    mergeAi.onclick = () => {
      if (!confirm(`Merge all ${total} suggestions into the knowledge base with AI? Each article that gets new material is rewritten to include it once (the old text is kept as an earlier version). New subjects become draft articles.`)) return;
      job.next = "merge";
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    };
    const none = isAdmin ? h("button", { class: "btn sm ghost" }, "Dismiss all") : null;
    if (none) none.onclick = busy(none, async () => {
      if (!confirm(`Dismiss all ${total} suggestions?`)) return;
      const r = await api("/kb/suggestions/dismiss-all", { method: "POST" });
      toast(`Dismissed ${r.dismissed}`);
      history.pushState(null, "", "/manual/kb");
      renderKb(main);
    });
    mount(detailEl, h("div", { class: "stack", style: { gap: "14px" } },
      h("div", { class: "card kb-bulk" },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("b", {}, `${total} suggested update${total === 1 ? "" : "s"}`),
          h("div", { class: "small muted" }, "What the AI noticed in finished support conversations that the knowledge base doesn't cover yet. Edit any card first if you like — your edits are kept when you accept all. Accepted additions go into the article; new articles start as drafts."),
          progress),
        isAdmin && st.ai ? mergeAi : null, isAdmin ? [all, none] : null),
      suggestions.map((s) => suggestionCard(s)),
      total > suggestions.length ? h("p", { class: "small muted" }, `Showing the newest ${suggestions.length}; “Accept all” takes all ${total}.`) : null));
  }
  const edited = new Map(); // suggestion id → changes made on the page, used by “Accept all”

  function suggestionCard(s) {
    const target = h("select", { class: "input" },
      h("option", { value: "", selected: !s.article_id }, "New article (draft)"),
      st.articles.map((a) => h("option", { value: a.id, selected: a.id === s.article_id }, `Add to: ${a.title}`)));
    const title = h("input", { class: "input", value: s.title, "aria-label": "Heading" });
    const remember = () => edited.set(String(s.id), { title: title.value, content_html: body.innerHTML, article_id: target.value || null });
    const { el: editor, body } = articleEditor(s.content_html, remember, true);
    title.addEventListener("input", remember);
    target.addEventListener("change", remember);
    const card = h("div", { class: "card kb-sugg-card" });
    const accept = h("button", { class: "btn primary sm" }, icon("check"), "Accept");
    accept.onclick = busy(accept, async () => {
      const r = await api(`/kb/suggestions/${s.id}/accept`, { method: "POST", body: { title: title.value, content_html: body.innerHTML, article_id: target.value || null } });
      toast(target.value ? "Added to the article" : "New draft article created");
      card.remove();
      edited.delete(String(s.id));
      Object.assign(st, await api("/kb"));
      drawStatus();
      drawList();
      if (!target.value) { history.pushState(null, "", `/manual/kb/${encodeURIComponent(r.articleId)}`); renderKb(main); }
    });
    const dismiss = h("button", { class: "btn sm ghost" }, "Dismiss");
    dismiss.onclick = busy(dismiss, async () => {
      await api(`/kb/suggestions/${s.id}/dismiss`, { method: "POST" });
      card.remove();
      edited.delete(String(s.id));
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
