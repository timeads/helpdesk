// Tuft the World "Ask" box for the learn hub. Add to the theme where the search box was:
//   <div id="ttw-ask"></div>
//   <script src="https://<helpdesk>/ask/ask.js" data-color="#1a1a1a" data-contact="/pages/contact" data-placeholder="…" defer></script>
// Visitors describe a problem or ask a question; the answer comes from our articles, products and classes,
// with links to the articles it used. Lives in a shadow root, inheriting the theme's font and text color.
(() => {
  if (window.__ttwAsk) return;
  window.__ttwAsk = true;
  const script = document.currentScript || document.querySelector('script[src*="/ask/ask.js"]');
  const API = `${new URL(script?.src || location.href).origin}/chat-api`;
  const color = /^#[0-9a-f]{3,8}$/i.test(script?.dataset.color || "") ? script.dataset.color : "#1a1a1a";
  const contact = script?.dataset.contact || "/pages/contact";
  const placeholder = script?.dataset.placeholder || "Describe what's going on, or ask anything — e.g. “My machine keeps skipping stitches” or “Which machine is best for a beginner?”";

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (k === "class") n.className = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  };
  const call = async (path, body) => {
    const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong — please try again");
    return data;
  };

  const CSS = `
:host { display: block; font: inherit; color: inherit; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.box { border: 1px solid rgba(0,0,0,.14); border-radius: 14px; padding: 16px; background: rgba(255,255,255,.6); }
textarea, select { font: inherit; color: #222; background: #fff; border: 1px solid rgba(0,0,0,.2); border-radius: 10px; padding: 12px 14px; width: 100%; }
textarea { resize: vertical; min-height: 84px; font-size: 16px; line-height: 1.45; }
textarea:focus, select:focus, button:focus-visible, a:focus-visible { outline: 3px solid ${color}; outline-offset: 2px; }
.row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
select { width: auto; flex: 1 1 200px; padding: 10px 12px; font-size: 15px; }
.go { font: inherit; font-weight: 700; background: ${color}; color: #fff; border: 0; border-radius: 999px; padding: 11px 22px; cursor: pointer; }
.go:disabled { opacity: .55; cursor: default; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chip { font: inherit; font-size: 14px; background: transparent; color: inherit; border: 1px solid rgba(0,0,0,.2); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
.chip:hover { border-color: ${color}; }
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; }
.err { color: #b42318; margin-top: 10px; font-size: 15px; }
.out { margin-top: 18px; }
.thinking { display: flex; align-items: center; gap: 10px; opacity: .8; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: p 1s infinite alternate; }
.dot:nth-child(2) { animation-delay: .2s; } .dot:nth-child(3) { animation-delay: .4s; }
@keyframes p { to { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.card { border: 1px solid rgba(0,0,0,.12); border-radius: 14px; padding: 18px 20px; background: #fff; color: #222; }
.lead { font-size: 1.05em; line-height: 1.55; margin: 0 0 12px; }
.askback { background: rgba(0,0,0,.04); border-left: 4px solid ${color}; padding: 10px 14px; border-radius: 0 8px 8px 0; margin: 12px 0; }
ol.steps { margin: 0 0 14px; padding-left: 1.4em; line-height: 1.5; }
ol.steps li { margin: 6px 0; }
sup a { color: ${color}; font-weight: 700; text-decoration: none; margin-left: 2px; }
h4 { font-size: .8em; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 18px 0 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.item { display: flex; gap: 12px; text-decoration: none; color: inherit; border: 1px solid rgba(0,0,0,.1); border-radius: 12px; padding: 10px; align-items: flex-start; }
.item:hover { border-color: ${color}; }
.item img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; flex: none; background: rgba(0,0,0,.05); }
.item .n { flex: none; width: 26px; height: 26px; border-radius: 50%; background: ${color}; color: #fff; font-weight: 700; font-size: 13px; display: grid; place-items: center; }
.item b { display: block; line-height: 1.3; }
.item small { display: block; opacity: .75; margin-top: 4px; line-height: 1.4; }
.price { font-weight: 700; margin-top: 4px; display: block; }
.dates { margin: 6px 0 0; padding: 0; list-style: none; font-size: 14px; }
.foot { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(0,0,0,.1); font-size: 15px; }
.thumbs button { font: inherit; background: none; border: 1px solid rgba(0,0,0,.2); border-radius: 999px; padding: 4px 12px; cursor: pointer; margin-left: 6px; }
.thumbs button[aria-pressed="true"] { background: ${color}; color: #fff; border-color: ${color}; }
.chat { font: inherit; font-weight: 700; background: none; color: ${color}; border: 2px solid ${color}; border-radius: 999px; padding: 8px 16px; cursor: pointer; text-decoration: none; }
.note { font-size: 13px; opacity: .65; margin-top: 10px; }
`;

  function mount() {
    const host = document.getElementById("ttw-ask") || script?.parentElement?.insertBefore(el("div"), script) || document.body.appendChild(el("div"));
    if (host.shadowRoot) return;
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", {}, CSS));

    const q = el("textarea", { "aria-label": "Describe your problem or ask a question", maxlength: "800", placeholder });
    const machine = el("select", { "aria-label": "Your machine (optional)" }, el("option", { value: "" }, "Your machine (optional)"));
    const hp = el("input", { class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const go = el("button", { class: "go", type: "submit" }, "Ask");
    const err = el("div", { class: "err", role: "alert" });
    const out = el("div", { class: "out", "aria-live": "polite" });
    const examples = ["My machine keeps skipping stitches", "Which machine should I buy?", "When is the next class?", "How do I finish the back of a rug?"];
    const chips = el("div", { class: "chips" }, examples.map((t) => el("button", { type: "button", class: "chip", onclick: () => { q.value = t; ask(); } }, t)));
    const form = el("form", { class: "box" }, q, el("div", { class: "row" }, machine, go), hp, chips, err);
    root.append(form, out);

    try { q.value = new URL(location.href).searchParams.get("q") || ""; } catch { /* old browsers */ } // links from the old search
    let last = null; // { question, askBack }
    call("/ask/config").then((c) => {
      for (const m of c.machines || []) machine.append(el("option", { value: m }, m));
      if (!c.ai) { form.hidden = true; }
    }).catch(() => { /* config is optional; asking still reports errors */ });

    form.addEventListener("submit", (e) => { e.preventDefault(); ask(); });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); });

    async function ask() {
      const text = q.value.trim();
      if (!text || go.disabled) return;
      // Answering our follow-up question: keep the original question with it
      const question = last?.askBack ? `${last.question}\n\n(${last.askBack}) ${text}` : text;
      err.textContent = "";
      go.disabled = true;
      chips.hidden = true;
      out.replaceChildren(el("div", { class: "thinking" }, el("span", { class: "dot" }), el("span", { class: "dot" }), el("span", { class: "dot" }), "Reading our guides…"));
      try {
        const r = await call("/ask", { question, machine: machine.value, page: location.href, website: hp.value });
        last = { question, askBack: r.askBack };
        out.replaceChildren(render(r, question));
        if (r.askBack) { q.value = ""; q.placeholder = "Type your answer…"; }
      } catch (x) {
        out.replaceChildren();
        err.textContent = x.message;
        chips.hidden = false;
      } finally {
        go.disabled = false;
      }
    }

    function chatButton(question) {
      const label = "Chat with us";
      if (window.TTWChat) return el("button", { type: "button", class: "chat", onclick: () => window.TTWChat.open(question) }, label);
      return el("a", { class: "chat", href: contact }, "Contact us");
    }

    function render(r, question) {
      const refLink = (n) => {
        const a = r.articles.find((x) => x.n === n);
        return a ? el("sup", {}, el("a", { href: a.url, title: a.title }, `[${n}]`)) : null;
      };
      const thumbs = el("span", { class: "thumbs" }, "Did this help?",
        [[1, "👍 Yes"], [-1, "👎 No"]].map(([v, t]) => el("button", {
          type: "button", "aria-pressed": "false",
          onclick: async (e) => {
            thumbs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
            call(`/ask/${r.id}/feedback`, { helpful: v }).catch(() => {});
            if (v === -1 && !foot.querySelector(".sorry")) foot.append(el("span", { class: "sorry" }, "Sorry about that — we can help directly: "), chatButton(question));
          },
        }, t)));
      const foot = el("div", { class: "foot" }, thumbs, r.handoff ? null : el("span", {}, "Still stuck? ", chatButton(question)));
      return el("div", { class: "card" },
        el("p", { class: "lead" }, r.answer),
        r.steps.length ? el("ol", { class: "steps" }, r.steps.map((s) => el("li", {}, s.text, s.refs.map(refLink)))) : null,
        r.products.length ? [el("h4", {}, "Our picks for you"), el("div", { class: "grid" }, r.products.map((p) =>
          el("a", { class: "item", href: p.url }, p.image ? el("img", { src: p.image, alt: "", loading: "lazy" }) : null,
            el("span", {}, el("b", {}, p.title), el("span", { class: "price" }, p.price), el("small", {}, p.why)))))] : null,
        r.classes.length ? [el("h4", {}, "Classes"), el("div", { class: "grid" }, r.classes.map((c) =>
          el(c.url ? "a" : "div", { class: "item", href: c.url || undefined },
            el("span", {}, el("b", {}, c.title), c.price ? el("span", { class: "price" }, c.price) : null, el("small", {}, c.why),
              c.dates.length ? el("ul", { class: "dates" }, c.dates.map((d) => el("li", {}, d))) : el("small", {}, "Choose a date on the class page")))))] : null,
        r.askBack ? el("div", { class: "askback" }, r.askBack) : null,
        r.handoff ? el("p", {}, "This one's best handled by our team. ", chatButton(question)) : null,
        r.articles.length ? [el("h4", {}, "From these articles"), el("div", { class: "grid" }, r.articles.map((a) =>
          el("a", { class: "item", href: a.url }, el("span", { class: "n" }, String(a.n)), a.image ? el("img", { src: a.image, alt: "", loading: "lazy" }) : null,
            el("span", {}, el("b", {}, a.title)))))] : null,
        foot,
        el("div", { class: "note" }, "Answers are written by AI from our guides — double-check before you cut or glue anything important."));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
