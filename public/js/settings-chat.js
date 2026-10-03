// Settings → Chat: turn the website chat on, how the AI takes part, office hours, how it looks,
// and the one line that installs it in the Shopify theme.
import { api } from "./api.js";
import { h, mount, toast, busy, icon } from "./ui.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "Europe/London"];
const AI_MODES = [
  ["draft", "Draft for us", "The AI writes each reply; a teammate checks it and sends it."],
  ["auto", "Answer automatically", "The AI replies to customers itself and hands off to a person when it should."],
  ["off", "Off", "Only people reply."],
];

export function chatCard() {
  const el = h("section", { class: "card", id: "chat" }, h("h2", {}, "Website chat"), h("p", { class: "muted" }, "Loading…"));
  api("/chats/settings").then((r) => draw(el, r)).catch((e) => mount(el, h("h2", {}, "Website chat"), h("div", { class: "notice bad" }, e.message)));
  return el;
}

function draw(el, r) {
  const s = structuredClone(r.settings);
  const save = h("button", { class: "btn save-btn" }, "Save chat settings");
  const dirty = () => save.classList.add("primary");
  save.onclick = busy(save, async () => {
    const out = await api("/chats/settings", { method: "PUT", body: { settings: s } });
    Object.assign(s, out.settings);
    save.classList.remove("primary");
    mount(statusEl, statusLine(out.open, out.hours));
    toast("Chat settings saved");
  });

  const check = (key, label) => {
    const c = h("input", { type: "checkbox", checked: !!s[key] });
    c.onchange = () => { s[key] = c.checked; dirty(); };
    return h("label", { class: "check" }, c, label);
  };
  const text = (key, label, attrs = {}) => {
    const i = h(attrs.rows ? "textarea" : "input", { class: "input", ...attrs });
    i.value = s[key] ?? "";
    i.oninput = () => { s[key] = attrs.type === "number" ? Number(i.value) : i.value; dirty(); };
    return h("label", { class: "field" }, label, i);
  };

  // AI mode
  const modeEl = h("div", { class: "stack", style: { gap: "6px" } });
  const drawMode = () => mount(modeEl, AI_MODES.map(([v, t, d]) => {
    const r_ = h("input", { type: "radio", name: "ai-mode", checked: s.aiMode === v });
    r_.onchange = () => { s.aiMode = v; dirty(); drawMode(); };
    return h("label", { class: "radio-card" + (s.aiMode === v ? " on" : "") }, r_, h("span", {}, h("b", {}, t), h("span", { class: "small muted", style: { display: "block" } }, d)));
  }));
  drawMode();

  // Office hours
  const hoursEl = h("div", { class: "hours-grid" }, s.hours.map((d, i) => {
    const on = h("input", { type: "checkbox", checked: d.on, "aria-label": `Open on ${DAYS[i]}` });
    const start = h("input", { class: "input", type: "time", value: d.start, disabled: !d.on, "aria-label": `${DAYS[i]} opens` });
    const end = h("input", { class: "input", type: "time", value: d.end, disabled: !d.on, "aria-label": `${DAYS[i]} closes` });
    on.onchange = () => { d.on = on.checked; start.disabled = end.disabled = !d.on; dirty(); };
    start.onchange = () => { d.start = start.value; dirty(); };
    end.onchange = () => { d.end = end.value; dirty(); };
    return [h("label", { class: "check" }, on, DAYS[i]), start, h("span", { class: "muted small" }, "to"), end];
  }));
  const zone = h("select", { class: "input" }, [...new Set([s.timezone, ...ZONES])].map((z) => h("option", { value: z, selected: z === s.timezone }, z.replace(/_/g, " "))));
  zone.onchange = () => { s.timezone = zone.value; dirty(); };

  const color = h("input", { type: "color", value: s.color, "aria-label": "Chat color" });
  color.oninput = () => { s.color = color.value; dirty(); };
  const pos = h("select", { class: "input" }, [["right", "Bottom right"], ["left", "Bottom left"]].map(([v, t]) => h("option", { value: v, selected: s.position === v }, t)));
  pos.onchange = () => { s.position = pos.value; dirty(); };
  const origins = h("textarea", { class: "input", rows: 3 });
  origins.value = s.origins.join("\n");
  origins.oninput = () => { s.origins = origins.value.split(/\s+/).filter(Boolean); dirty(); };

  // Install
  const snippet = `<script src="${r.origin}/chat/widget.js" data-name="{{ customer.name }}" data-email="{{ customer.email }}" defer></script>`;
  const copy = h("button", { class: "btn sm" }, icon("copy"), "Copy");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(snippet); toast("Copied — paste it into theme.liquid"); } catch { toast("Select the code and copy it", true); }
  };
  const alerts = h("button", { class: "btn sm" }, icon("bolt"), "Turn on desktop alerts");
  alerts.onclick = async () => {
    if (!("Notification" in window)) return toast("This browser can't show desktop alerts", true);
    const p = await Notification.requestPermission();
    toast(p === "granted" ? "Desktop alerts are on for this computer" : "Alerts are blocked — allow notifications for this site in the browser", p !== "granted");
  };

  const statusEl = h("div", {}, statusLine(r.open, r.hours));
  mount(el,
    h("h2", {}, "Website chat"),
    h("p", { class: "muted" }, "A chat bubble on your store. Each chat becomes a ticket in Live chats. The AI answers from your repair manual, AI knowledge and saved replies, and only shares order details when the order number and email match. If nobody picks a chat up, it moves to email with the transcript."),
    statusEl,
    h("div", { class: "stack", style: { gap: "18px", marginTop: "14px" } },
      check("enabled", "Show the chat on the website"),
      h("div", {}, h("h3", { class: "section", style: { marginTop: 0 } }, "AI replies"), modeEl),
      h("div", {},
        h("h3", { class: "section" }, "Office hours"),
        h("p", { class: "small muted", style: { marginTop: 0 } }, "When a person can reply live. Outside these hours, chats that need a person move straight to email."),
        hoursEl,
        h("div", { class: "grid3", style: { marginTop: "10px" } },
          h("label", { class: "field" }, "Time zone", zone),
          text("handoffMinutes", "Move to email if nobody replies within (minutes)", { type: "number", min: 1, max: 60 }),
          text("maxAiReplies", "Most AI replies in one chat", { type: "number", min: 1, max: 50 }))),
      check("allowPhotos", "Let customers send photos in the chat"),
      h("div", {},
        h("h3", { class: "section" }, "How it looks"),
        h("div", { class: "grid2" }, text("title", "Title", { maxlength: 60 }), h("div", { class: "row", style: { gap: "12px", alignItems: "flex-end" } }, h("label", { class: "field" }, "Color", color), h("label", { class: "field", style: { flex: 1 } }, "Position", pos))),
        h("div", { class: "grid2", style: { marginTop: "10px" } },
          text("greeting", "Greeting", { rows: 2, maxlength: 300 }),
          text("offlineMessage", "After-hours message", { rows: 2, maxlength: 300 }))),
      h("div", {},
        h("h3", { class: "section" }, "Install on your store"),
        h("p", { class: "small muted", style: { marginTop: 0 } }, "In Shopify: Online Store → Themes → ⋯ → Edit code → layout/theme.liquid. Paste this just above </body> and save. Logged-in customers get their name and email filled in."),
        h("pre", { class: "code-block" }, snippet),
        h("div", { class: "row", style: { gap: "8px", marginTop: "8px" } }, copy,
          h("a", { class: "btn sm ghost", href: "/chat/test.html", target: "_blank", rel: "noopener" }, icon("ext"), "Try it here first"), alerts),
        h("label", { class: "field", style: { marginTop: "12px" } }, "Sites allowed to show the chat (one per line)", origins)),
      h("div", { class: "row" }, save)));
}

function statusLine(open, hours) {
  return h("div", { class: "notice", style: { color: "var(--text)" } },
    h("span", { class: "chat-dot" + (open ? " on" : ""), style: { display: "inline-block", marginRight: "8px" } }),
    open ? `You're open now (${hours}) — chats that need a person wait for a teammate.` : `You're closed right now (${hours}) — chats that need a person go to email.`);
}
