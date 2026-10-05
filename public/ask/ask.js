// Tuft the World "Ask" box for the learn hub. Add to the theme where the search box was:
//   <div id="ttw-ask"></div>
//   <script src="https://<helpdesk>/ask/ask.js" data-color="#1a1a1a" data-accent="#c78c2b" data-contact="/pages/contact" data-placeholder="…" defer></script>
// Visitors describe a problem or ask a question; the answer comes from our articles, products and classes,
// with links to the articles it used. Lives in a shadow root, inheriting the theme's font and text color.
(() => {
  if (window.__ttwAsk) return;
  window.__ttwAsk = true;
  const script = document.currentScript || document.querySelector('script[src*="/ask/ask.js"]');
  const API = `${new URL(script?.src || location.href).origin}/chat-api`;
  const color = /^#[0-9a-f]{3,8}$/i.test(script?.dataset.color || "") ? script.dataset.color : "#1a1a1a";
  const accent = /^#[0-9a-f]{3,8}$/i.test(script?.dataset.accent || "") ? script.dataset.accent : "#c78c2b"; // highlight (step numbers, tints)
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
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  };
  const call = async (path, body) => {
    const r = await fetch(API + path, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Something went wrong — please try again");
    return data;
  };

  const CSS = `
:host { display: block; font: inherit; color: inherit; text-align: left; }
[hidden] { display: none !important; }
* { box-sizing: border-box; }
.box { position: relative; border: 1px solid rgba(0,0,0,.1); border-top: 4px solid ${accent}; border-radius: 16px; padding: 22px 24px 20px; background: #fff; color: #222; box-shadow: 0 8px 28px rgba(0,0,0,.06); }
@media (max-width: 560px) { .box { padding: 18px 16px; } }
.eyebrow { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #1a1a1a; background: color-mix(in srgb, ${accent} 20%, #fff); border-radius: 999px; padding: 4px 10px; }
.eyebrow svg { width: 14px; height: 14px; }
.title { font-size: 1.3em; font-weight: 700; line-height: 1.25; margin: 10px 0 4px; color: #1a1a1a; }
.help { font-size: .95em; color: #555; margin: 10px 0 14px; line-height: 1.45; }
textarea, select { font: inherit; color: #222; background: #fff; border: 1.5px solid rgba(0,0,0,.18); border-radius: 12px; padding: 14px 16px; width: 100%; }
textarea { resize: vertical; min-height: 96px; font-size: 17px; line-height: 1.45; }
textarea::placeholder { color: #8a8a8a; }
textarea:focus, select:focus { border-color: ${color}; }
textarea:focus, select:focus, button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, ${accent} 45%, transparent); outline-offset: 1px; }
.row { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; align-items: flex-end; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 0 1 300px; min-width: 200px; }
.field span { font-size: 12.5px; font-weight: 600; color: #555; }
select { padding: 10px 12px; font-size: 15px; }
.go { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 16px; font-weight: 700; background: ${color}; color: #fff; border: 0; border-radius: 999px; padding: 12px 26px; cursor: pointer; }
.go svg { width: 16px; height: 16px; }
.go:disabled { opacity: .55; cursor: default; }
@media (max-width: 560px) { .field { flex: 1 1 100%; } .go { width: 100%; justify-content: center; } }
.popular { margin-top: 18px; padding-top: 14px; border-top: 1px solid rgba(0,0,0,.08); }
.popular-label { font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #777; margin-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font: inherit; font-size: 14px; background: color-mix(in srgb, ${accent} 12%, #fff); color: #1a1a1a; border: 1px solid transparent; border-radius: 999px; padding: 7px 14px; cursor: pointer; }
.chip:hover { border-color: ${accent}; background: color-mix(in srgb, ${accent} 20%, #fff); }
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; }
.err { color: #b42318; margin-top: 10px; font-size: 15px; }
.out { margin-top: 18px; }
.thinking { display: flex; align-items: center; gap: 10px; opacity: .8; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; animation: p 1s infinite alternate; }
.dot:nth-child(2) { animation-delay: .2s; } .dot:nth-child(3) { animation-delay: .4s; }
@keyframes p { to { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.card { border: 1px solid rgba(0,0,0,.12); border-radius: 16px; padding: 22px 24px; background: #fff; color: #222; line-height: 1.55; }
@media (max-width: 560px) { .card { padding: 18px 16px; } }
.kind { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #222;
  background: color-mix(in srgb, ${accent} 22%, #fff); border-radius: 999px; padding: 4px 10px; margin-bottom: 12px; }
.kind span { font-weight: 500; text-transform: none; letter-spacing: 0; opacity: .8; }
.lead { font-size: 1.12em; line-height: 1.55; margin: 0; padding: 14px 16px; border-left: 4px solid ${accent}; background: color-mix(in srgb, ${accent} 9%, #fff); border-radius: 0 10px 10px 0; color: #1a1a1a; }
h3 { font-size: 1.05em; font-weight: 700; margin: 24px 0 10px; color: #1a1a1a; }
ol.steps { list-style: none; margin: 0; padding: 0; counter-reset: step; }
ol.steps li { counter-increment: step; display: grid; grid-template-columns: 30px 1fr; gap: 12px; padding: 12px 0; border-top: 1px solid rgba(0,0,0,.08); align-items: start; }
ol.steps li:first-child { border-top: 0; padding-top: 4px; }
ol.steps li::before { content: counter(step); width: 30px; height: 30px; border-radius: 50%; background: ${accent}; color: #1a1a1a; font-weight: 700; font-size: 14px; display: grid; place-items: center; }
ol.steps b { color: #1a1a1a; }
.refs { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: 1px; }
.refs a { font-size: 11px; font-weight: 700; color: #1a1a1a; text-decoration: none; background: color-mix(in srgb, ${accent} 22%, #fff); border-radius: 999px; padding: 1px 7px; }
.refs a:hover { background: ${accent}; }
.askback { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; background: #f6f6f4; border: 1px solid rgba(0,0,0,.1); border-radius: 12px; padding: 14px 16px; margin: 22px 0 4px; }
.askback .q { flex: 1 1 260px; }
.askback .q small { display: block; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; opacity: .65; margin-bottom: 2px; }
.askback .q p { margin: 0; font-weight: 600; color: #1a1a1a; }
.reply { font: inherit; font-size: 14px; font-weight: 700; background: #fff; color: #1a1a1a; border: 1px solid rgba(0,0,0,.25); border-radius: 999px; padding: 7px 14px; cursor: pointer; }
.reply:hover { border-color: ${color}; }
.handoff { margin: 18px 0 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.item { display: flex; gap: 12px; text-decoration: none; color: inherit; border: 1px solid rgba(0,0,0,.1); border-radius: 12px; padding: 10px; align-items: flex-start; }
.item:hover { border-color: ${color}; }
.item img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; flex: none; background: rgba(0,0,0,.05); }
.item .n { flex: none; width: 26px; height: 26px; border-radius: 50%; background: color-mix(in srgb, ${accent} 22%, #fff); color: #1a1a1a; font-weight: 700; font-size: 13px; display: grid; place-items: center; }
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
    const machine = el("select", {}, el("option", { value: "" }, "Choose or skip"));
    const hp = el("input", { class: "hp", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    const go = el("button", { class: "go", type: "submit" }, "Ask");
    const err = el("div", { class: "err", role: "alert" });
    const out = el("div", { class: "out", "aria-live": "polite" });
    const examples = ["My machine keeps skipping stitches", "Which machine should I buy?", "When is the next class?", "How do I finish the back of a rug?"];
    const chips = el("div", { class: "popular" }, el("div", { class: "popular-label" }, "Popular questions"),
      el("div", { class: "chips" }, examples.map((t) => el("button", { type: "button", class: "chip", onclick: () => { q.value = t; ask(); } }, t))));
    const sparkle = () => { const n = document.createElementNS("http://www.w3.org/2000/svg", "svg"); n.setAttribute("viewBox", "0 0 24 24"); n.setAttribute("aria-hidden", "true"); n.innerHTML = '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z" fill="currentColor"/>'; return n; };
    go.prepend(sparkle());
    const form = el("form", { class: "box" },
      el("span", { class: "eyebrow" }, sparkle(), "Ask us anything"),
      el("p", { class: "help" }, "Describe a problem or ask a question — about your machine, what to buy, or our classes. We'll answer from our guides and link the ones to read."),
      q,
      el("div", { class: "row" }, el("label", { class: "field" }, el("span", {}, "Your machine (optional)"), machine), go),
      hp, chips, err);
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
      const KIND = { fix: "Troubleshooting", buy: "Buying advice", stock: "Availability", classes: "Classes", general: "Answer", order: "Your order" };
      // The first sentence of a step is the action — bold it so the list can be skimmed
      const stepText = (t) => {
        const m = t.match(/^(.{8,120}?[.!?:])(\s+)([\s\S]+)$/);
        return m ? [el("b", {}, m[1]), m[2] + m[3]] : [el("b", {}, t)];
      };
      const refs = (ns) => ns.length ? el("span", { class: "refs" }, ns.map((n) => {
        const a = r.articles.find((x) => x.n === n);
        return a ? el("a", { href: a.url, title: `From: ${a.title}`, "aria-label": `Source ${n}: ${a.title}` }, String(n)) : null;
      })) : null;
      return el("div", { class: "card" },
        el("div", { class: "kind" }, KIND[r.kind] || "Answer", machine.value ? el("span", {}, `· ${machine.value}`) : null),
        el("p", { class: "lead" }, r.answer),
        r.steps.length ? [el("h3", {}, r.kind === "fix" ? "What to try" : "Steps"), el("ol", { class: "steps" }, r.steps.map((st) => el("li", {}, el("div", {}, stepText(st.text), refs(st.refs)))))] : null,
        r.products.length ? [el("h3", {}, "Our picks for you"), el("div", { class: "grid" }, r.products.map((p) =>
          el("a", { class: "item", href: p.url }, p.image ? el("img", { src: p.image, alt: "", loading: "lazy" }) : null,
            el("span", {}, el("b", {}, p.title), el("span", { class: "price" }, p.price), el("small", {}, p.why)))))] : null,
        r.classes.length ? [el("h3", {}, "Classes"), el("div", { class: "grid" }, r.classes.map((c) =>
          el(c.url ? "a" : "div", { class: "item", href: c.url || undefined },
            el("span", {}, el("b", {}, c.title), c.price ? el("span", { class: "price" }, c.price) : null, el("small", {}, c.why),
              c.dates.length ? el("ul", { class: "dates" }, c.dates.map((d) => el("li", {}, d))) : el("small", {}, "Choose a date on the class page")))))] : null,
        r.askBack ? el("div", { class: "askback" },
          el("div", { class: "q" }, el("small", {}, "Quick question"), el("p", {}, r.askBack)),
          el("button", { type: "button", class: "reply", onclick: () => { q.focus(); q.scrollIntoView({ block: "center", behavior: "smooth" }); } }, "Answer")) : null,
        r.handoff ? el("p", { class: "handoff" }, "This one's best handled by our team. ", chatButton(question)) : null,
        r.articles.length ? [el("h3", {}, "From these articles"), el("div", { class: "grid" }, r.articles.map((a) =>
          el("a", { class: "item", href: a.url }, el("span", { class: "n" }, String(a.n)), a.image ? el("img", { src: a.image, alt: "", loading: "lazy" }) : null,
            el("span", {}, el("b", {}, a.title)))))] : null,
        foot,
        el("div", { class: "note" }, "Answers are automatically summarized from our guides."));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
