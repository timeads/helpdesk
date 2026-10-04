// Tuft the World website chat. Add to the Shopify theme (layout/theme.liquid, before </body>):
//   <script src="https://<helpdesk>/chat/widget.js" data-name="{{ customer.name }}" data-email="{{ customer.email }}" defer></script>
// Everything lives in a shadow root so the theme's CSS can't touch it (and it can't touch the theme).
(() => {
  if (window.__ttwChat) return;
  window.__ttwChat = true;
  const script = document.currentScript || document.querySelector('script[src*="/chat/widget.js"]');
  const BASE = new URL(script?.src || location.href).origin;
  const API = `${BASE}/chat-api`;
  const KEY = "ttw-chat";
  const prefill = { name: (script?.dataset.name || "").trim(), email: (script?.dataset.email || "").trim() };
  const preview = script?.dataset.preview === "1";
  const ACCENT = /^#[0-9a-f]{3,8}$/i.test(script?.dataset.accent || "") ? script.dataset.accent : "#c78c2b"; // step numbers, same as the Ask box

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* private mode */ } },
  };

  // ---- tiny DOM helper
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
  const svg = (d) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = d;
    return s;
  };
  const ICON = {
    chat: '<path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    x: '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="m21 16-5-5-9 9" fill="none" stroke="currentColor" stroke-width="2"/>',
  };

  async function call(path, { method = "GET", body, token } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { "x-chat-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || "Something went wrong — please try again"), { status: res.status });
    return json;
  }

  /** Photos are shrunk to 1600px JPEG before upload. */
  async function photo(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("That file isn't a photo")); i.src = url; });
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      return { name: file.name.replace(/\.\w+$/, "") + ".jpg", mime: "image/jpeg", data: c.toDataURL("image/jpeg", 0.82).split(",")[1], preview: c.toDataURL("image/jpeg", 0.5) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const CSS = (color, side) => `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.launcher { position: fixed; ${side}: 20px; bottom: 20px; width: 58px; height: 58px; border-radius: 50%; border: 0; background: ${color}; color: #fff; cursor: pointer;
  box-shadow: 0 6px 20px rgba(0,0,0,.22); display: grid; place-items: center; z-index: 2147483000; transition: transform .15s; }
.launcher:hover { transform: scale(1.05); }
.launcher:focus-visible, button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 3px solid ${color}; outline-offset: 2px; }
.launcher svg { width: 26px; height: 26px; }
.badge { position: absolute; top: -2px; ${side === "right" ? "right" : "left"}: -2px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #d33; color: #fff; font: 700 12px/20px sans-serif; text-align: center; }
.panel { position: fixed; ${side}: 20px; bottom: 90px; width: 370px; height: min(600px, calc(100vh - 110px)); background: #fff; color: #222; border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25); display: flex; flex-direction: column; overflow: hidden; z-index: 2147483000; }
.panel[hidden] { display: none; }
@media (max-width: 480px) { .panel { inset: 0; width: auto; height: auto; border-radius: 0; } }
.head { background: ${color}; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
.head .t { font-weight: 700; font-size: 16px; }
.head .s { font-size: 12.5px; opacity: .9; display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa; }
.dot.on { background: #4ade80; }
.close { margin-left: auto; background: transparent; border: 0; color: #fff; cursor: pointer; width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; }
.close svg { width: 20px; height: 20px; }
.body { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #faf8f5; }
.msg { max-width: 82%; display: flex; flex-direction: column; gap: 3px; }
.msg .who { font-size: 11.5px; color: #777; padding: 0 4px; }
.msg .b { padding: 9px 12px; border-radius: 16px; font-size: 14.5px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; background: #fff; border: 1px solid #e8e3dc; border-top-left-radius: 5px; }
.msg.me { align-self: flex-end; align-items: flex-end; }
.msg.me .b { background: ${color}; color: #fff; border-color: transparent; border-top-left-radius: 16px; border-top-right-radius: 5px; }
.msg img { max-width: 200px; max-height: 200px; border-radius: 12px; display: block; border: 1px solid #e8e3dc; }
.sys { align-self: center; font-size: 12.5px; color: #6b6b6b; text-align: center; max-width: 90%; }
.typing { align-self: flex-start; font-size: 12.5px; color: #777; padding: 0 4px; }
.typing span { display: inline-block; animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; } .launcher { transition: none; } }
form.start { display: flex; flex-direction: column; gap: 10px; }
label { font-size: 13px; font-weight: 600; color: #444; display: flex; flex-direction: column; gap: 4px; }
input, textarea { font-size: 15px; padding: 10px 12px; border: 1px solid #d6d0c8; border-radius: 10px; background: #fff; color: #222; width: 100%; }
textarea { resize: none; }
.hp { position: absolute; left: -9999px; }
.primary { background: ${color}; color: #fff; border: 0; border-radius: 10px; padding: 12px; font-weight: 700; font-size: 15px; cursor: pointer; }
.primary:disabled { opacity: .6; cursor: default; }
.foot:empty { display: none; }
.foot { border-top: 1px solid #eee; padding: 10px; display: flex; flex-direction: column; gap: 6px; background: #fff; }
.row { display: flex; gap: 6px; align-items: flex-end; }
.row textarea { flex: 1; min-height: 44px; max-height: 120px; }
.icon-btn { width: 44px; height: 44px; flex: none; border-radius: 10px; border: 1px solid #d6d0c8; background: #fff; color: #555; cursor: pointer; display: grid; place-items: center; }
.icon-btn.send { background: ${color}; color: #fff; border-color: transparent; }
.icon-btn svg { width: 20px; height: 20px; }
.links { display: flex; justify-content: space-between; font-size: 12.5px; }
.link { background: none; border: 0; color: #555; text-decoration: underline; cursor: pointer; padding: 4px 2px; font-size: 12.5px; }
.err { color: #b42318; font-size: 13px; }
.pending { display: flex; gap: 6px; flex-wrap: wrap; }
.pending img { width: 48px; height: 48px; object-fit: cover; border-radius: 8px; }
.note { font-size: 13px; color: #555; background: #f3efe9; border-radius: 10px; padding: 10px 12px; }
/* Rich answers: numbered steps, article and product cards (same look as the learn hub's Ask box) */
.msg.rich { max-width: 94%; }
.msg .b p { margin: 0; }
.msg .b p + p { margin-top: 8px; }
.msg .b ol { list-style: none; margin: 8px 0 0; padding: 0; counter-reset: s; white-space: normal; }
.msg .b ol li { counter-increment: s; display: grid; grid-template-columns: 22px 1fr; gap: 8px; padding: 7px 0; border-top: 1px solid #efe9e1; align-items: start; }
.msg .b ol li:first-child { border-top: 0; padding-top: 2px; }
.msg .b ol li::before { content: counter(s); width: 22px; height: 22px; border-radius: 50%; background: ${ACCENT}; color: #1a1a1a; font-weight: 700; font-size: 12px; display: grid; place-items: center; }
.msg .b ol b { color: #1a1a1a; }
.msg .b a { color: inherit; text-decoration: underline; }
.cards { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.cards .lbl { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #777; padding: 4px 4px 0; }
.card { display: flex; gap: 10px; align-items: center; text-decoration: none; color: #222; background: #fff; border: 1px solid #e8e3dc; border-radius: 12px; padding: 8px 10px; }
.card:hover { border-color: ${color}; }
.card img { width: 46px; height: 46px; object-fit: cover; border-radius: 8px; flex: none; border: 0; max-width: none; }
.card .n { flex: none; width: 22px; height: 22px; border-radius: 50%; background: color-mix(in srgb, ${ACCENT} 25%, #fff); color: #1a1a1a; font-weight: 700; font-size: 12px; display: grid; place-items: center; }
.card .t { font-size: 13.5px; font-weight: 600; line-height: 1.3; display: block; }
.card .p { font-size: 13px; font-weight: 700; display: block; margin-top: 2px; }
.card .w { font-size: 12.5px; color: #666; display: block; margin-top: 2px; line-height: 1.35; }
`;

  async function boot() {
    let cfg;
    try {
      cfg = await call("/config");
    } catch {
      return;
    }
    if (!cfg.enabled && !preview) return;

    const host = el("div", { id: "ttw-chat" });
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", {}, CSS(cfg.color, cfg.position === "left" ? "left" : "right")));

    let saved = store.get(); // { id, token, after, seen }
    let state = null;
    let open = false;
    let unread = 0;
    let timer = null;
    const shown = new Set();
    const pending = [];

    const badge = el("span", { class: "badge", hidden: true });
    const launcher = el("button", { class: "launcher", "aria-label": "Chat with us", "aria-expanded": "false" }, svg(ICON.chat), badge);
    const status = el("div", { class: "s" }, el("span", { class: "dot" + (cfg.open ? " on" : "") }), cfg.open ? "We're online" : `We reply by email · ${cfg.hours}`);
    const closeBtn = el("button", { class: "close", "aria-label": "Close chat" }, svg(ICON.x));
    const body = el("div", { class: "body", "aria-live": "polite" });
    const foot = el("div", { class: "foot" });
    const panel = el("div", { class: "panel", role: "dialog", "aria-label": cfg.title, hidden: true },
      el("div", { class: "head" }, el("div", {}, el("div", { class: "t" }, cfg.title), status), closeBtn), body, foot);
    root.append(launcher, panel);

    const setOpen = (v) => {
      open = v;
      panel.hidden = !v;
      launcher.setAttribute("aria-expanded", String(v));
      if (v) {
        unread = 0;
        drawBadge();
        if (!saved) startForm();
        else poll();
        setTimeout(() => (root.querySelector("textarea, input:not(.hp)") || closeBtn).focus(), 50);
      } else launcher.focus();
    };
    launcher.addEventListener("click", () => setOpen(!open));
    // Other parts of the site (the learn hub's Ask box) can open the chat with a message ready to send
    window.TTWChat = {
      open(text = "") {
        if (!open) setOpen(true);
        if (!text) return;
        setTimeout(() => {
          const box = root.querySelector("textarea");
          if (box && !box.value) { box.value = String(text).slice(0, 2000); box.dispatchEvent(new Event("input")); box.focus(); }
        }, 80);
      },
    };
    window.dispatchEvent(new Event("ttw-chat-ready"));
    closeBtn.addEventListener("click", () => setOpen(false));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    const drawBadge = () => { badge.hidden = !unread; badge.textContent = unread > 9 ? "9+" : String(unread); };

    const bubble = (m) => {
      if (m.from === "system") return el("div", { class: "sys" }, m.text);
      const me = m.from === "visitor";
      const who = me ? null : m.from === "ai" ? "AI assistant" : m.name || "Tuft the World";
      const cards = m.cards && (m.cards.articles?.length || m.cards.products?.length) ? m.cards : null;
      const rich = !me && (cards || /(^|\n)\s*1[.)]\s/.test(m.text || ""));
      return el("div", { class: "msg" + (me ? " me" : "") + (rich ? " rich" : "") },
        who ? el("div", { class: "who" }, who) : null,
        m.text ? el("div", { class: "b", style: rich ? "white-space: normal" : null }, rich ? richText(m.text) : linkify(m.text)) : null,
        cards ? cardList(cards) : null,
        (m.files || []).map((f) => el("a", { href: `${API}/${saved.id}/files/${f.id}?t=${saved.token}`, target: "_blank", rel: "noopener" },
          el("img", { src: `${API}/${saved.id}/files/${f.id}?t=${saved.token}`, alt: f.name || "Photo" }))));
    };

    // ---- Rich answers
    const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,!?:;'"])/g;
    function linkify(text) {
      return String(text).split(URL_RE).map((part, i) => (i % 2 ? el("a", { href: part, target: "_blank", rel: "noopener" }, part) : part));
    }
    /** Paragraphs plus numbered steps ("1. Do this. Then…"): the first sentence of each step is the action, in bold. */
    function richText(text) {
      const out = [];
      let list = null;
      for (const line of String(text).split(/\n+/)) {
        const step = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (step) {
          if (!list) out.push((list = el("ol")));
          const m = step[1].match(/^(.{6,140}?[.!?:])(\s+)([\s\S]+)$/);
          list.append(el("li", {}, el("span", {}, ...(m ? [el("b", {}, m[1]), m[2], ...linkify(m[3])] : [el("b", {}, ...linkify(step[1]))]))));
        } else if (line.trim()) {
          list = null;
          out.push(el("p", {}, ...linkify(line.trim())));
        }
      }
      return out;
    }
    const abs = (src) => (src && src.startsWith("/") ? BASE + src : src);
    function cardList(c) {
      return el("div", { class: "cards" },
        c.products?.length ? [el("div", { class: "lbl" }, "Our picks"), c.products.map((p) =>
          el("a", { class: "card", href: p.url, target: "_blank", rel: "noopener" }, p.image ? el("img", { src: abs(p.image), alt: "", loading: "lazy" }) : null,
            el("span", {}, el("span", { class: "t" }, p.title), el("span", { class: "p" }, p.price), p.why ? el("span", { class: "w" }, p.why) : null)))] : null,
        c.articles?.length ? [el("div", { class: "lbl" }, "Read more"), c.articles.map((a, i) =>
          el("a", { class: "card", href: a.url, target: "_blank", rel: "noopener" }, el("span", { class: "n" }, String(i + 1)), a.image ? el("img", { src: abs(a.image), alt: "", loading: "lazy" }) : null,
            el("span", { class: "t" }, a.title)))] : null);
    }

    // ---- First screen: who you are + your question
    function startForm() {
      body.replaceChildren(...[
        cfg.greeting ? bubble({ from: "agent", name: cfg.title.replace(/^Chat with /, ""), text: cfg.greeting }) : null,
        !cfg.open ? el("div", { class: "note" }, cfg.offlineMessage) : null,
      ].filter(Boolean));
      const name = el("input", { name: "name", autocomplete: "name", value: prefill.name || "" });
      const email = el("input", { name: "email", type: "email", required: true, autocomplete: "email", value: prefill.email || "" });
      const message = el("textarea", { name: "message", rows: 3, required: true, placeholder: "How can we help?" });
      const hp = el("input", { class: "hp", name: "website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
      const err = el("div", { class: "err", role: "alert" });
      const go = el("button", { class: "primary", type: "submit" }, "Start chat");
      const form = el("form", { class: "start" },
        el("label", {}, "Name", name), el("label", {}, "Email (so we can follow up)", email), el("label", {}, "Message", message),
        cfg.photos ? photoPicker() : null, hp, err, go);
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.textContent = "";
        go.disabled = true;
        go.textContent = "Starting…";
        try {
          const r = await call("/start", { method: "POST", body: { name: name.value, email: email.value, message: message.value, page: location.href, website: hp.value, files: pending.splice(0).map(({ preview: _p, ...f }) => f) } });
          saved = { id: r.id, token: r.token, after: 0 };
          store.set(saved);
          chatView();
          poll();
        } catch (x) {
          err.textContent = x.message;
          go.disabled = false;
          go.textContent = "Start chat";
        }
      });
      body.append(form);
      foot.replaceChildren();
    }

    function photoPicker(onChange) {
      const input = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
      const list = el("div", { class: "pending" });
      const draw = () => { list.replaceChildren(...pending.map((p) => el("img", { src: p.preview, alt: p.name }))); onChange?.(); };
      input.addEventListener("change", async () => {
        for (const f of [...input.files].slice(0, 4 - pending.length)) {
          try { pending.push(await photo(f)); } catch { /* skip unreadable files */ }
        }
        input.value = "";
        draw();
      });
      const btn = el("button", { type: "button", class: "link", onclick: () => input.click() }, "Add a photo");
      btn.pick = () => input.click();
      return el("div", {}, btn, input, list);
    }

    // ---- The conversation
    let typingEl = null;
    function chatView() {
      body.replaceChildren();
      shown.clear();
      saved.after = 0;
      const box = el("textarea", { rows: 1, placeholder: "Type a message…", "aria-label": "Message" });
      const err = el("div", { class: "err", role: "alert" });
      const pick = cfg.photos ? photoPicker() : null;
      const photoBtn = cfg.photos ? el("button", { class: "icon-btn", type: "button", "aria-label": "Add a photo", onclick: () => pick.querySelector("input").click() }, svg(ICON.image)) : null;
      if (pick) pick.firstChild.hidden = true;
      const send = el("button", { class: "icon-btn send", type: "button", "aria-label": "Send" }, svg(ICON.send));
      const doSend = async () => {
        const text = box.value.trim();
        if (!text && !pending.length) return;
        err.textContent = "";
        send.disabled = true;
        try {
          await call(`/${saved.id}/messages`, { method: "POST", token: saved.token, body: { text, files: pending.map(({ preview: _p, ...f }) => f) } });
          box.value = "";
          pending.length = 0;
          if (pick) pick.querySelector(".pending").replaceChildren();
          await poll();
        } catch (x) {
          err.textContent = x.message;
        } finally {
          send.disabled = false;
        }
      };
      send.addEventListener("click", doSend);
      let typed = 0;
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); } });
      box.addEventListener("input", () => {
        if (Date.now() - typed > 3000) { typed = Date.now(); call(`/${saved.id}/typing`, { method: "POST", token: saved.token }).catch(() => {}); }
      });
      const emailMe = el("button", { class: "link", type: "button" }, "Email me instead");
      emailMe.addEventListener("click", async () => {
        if (!confirm("We'll email you this conversation and carry on there. OK?")) return;
        try { await call(`/${saved.id}/email`, { method: "POST", token: saved.token }); await poll(); } catch (x) { err.textContent = x.message; }
      });
      foot.replaceChildren(...[err, pick, el("div", { class: "row" }, photoBtn, box, send), el("div", { class: "links" }, emailMe)].filter(Boolean));
    }

    function endedView() {
      const again = el("button", { class: "primary", type: "button" }, "Start a new chat");
      again.addEventListener("click", () => { saved = null; store.set(null); state = null; startForm(); });
      foot.replaceChildren(again);
    }

    async function poll() {
      clearTimeout(timer);
      if (!saved) return;
      try {
        const r = await call(`/${saved.id}?after=${saved.after || 0}`, { token: saved.token });
        if (!body.querySelector(".msg, .sys") && !state) chatView();
        if (state === null && !foot.querySelector("textarea") && !["email", "ended"].includes(r.state)) chatView();
        state = r.state;
        let fresh = 0;
        for (const m of r.messages) {
          if (shown.has(m.id)) continue;
          shown.add(m.id);
          typingEl?.remove();
          body.append(bubble(m));
          saved.after = Math.max(saved.after || 0, m.id);
          if (m.from !== "visitor") fresh++;
        }
        store.set(saved);
        if (fresh && !open) { unread += fresh; drawBadge(); }
        typingEl?.remove();
        const last = r.messages.at(-1) ?? null;
        const waitingOnUs = r.agentTyping || (r.thinking && body.lastElementChild?.classList.contains("me"));
        if (waitingOnUs && open) {
          typingEl = el("div", { class: "typing" }, r.agentTyping ? "Typing" : "", el("span", {}, "•"), el("span", {}, "•"), el("span", {}, "•"));
          body.append(typingEl);
        }
        if (fresh || last || waitingOnUs) body.scrollTop = body.scrollHeight;
        if (["email", "ended"].includes(state)) endedView();
      } catch (x) {
        if (x.status === 404) { saved = null; store.set(null); if (open) startForm(); return; }
      }
      if (["email", "ended"].includes(state)) return;
      timer = setTimeout(poll, open && !document.hidden ? 2500 : 15000);
    }

    // A chat from earlier in this visit carries on (unread badge while closed)
    if (saved) poll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
