// A website chat on its ticket: chat bubbles in the thread, live updates, the AI's draft to send or
// edit, a chat composer (Enter sends, photos allowed), and "Move to email".
import { api } from "./api.js";
import { h, mount, icon, fullTime, toast, busy, spinner, initials } from "./ui.js";

/** Shrinks a photo to at most 1600px and JPEG, as base64 (keeps chats light). */
export async function photoData(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file isn't a photo this browser can read"));
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.82).split(",")[1];
    return { name: file.name.replace(/\.\w+$/, "") + ".jpg", mime: "image/jpeg", data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One chat line in the ticket thread (customer left, us right, status lines centred). */
export function chatBubble(t, m) {
  const fileUrl = (a) => `/api/tickets/${t.id}/messages/${m.id}/attachments/${encodeURIComponent(a.id)}`;
  if (m.kind === "chat_system") return h("div", { class: "chat-sys", "data-mid": m.id }, m.body_text);
  const out = m.direction === "out";
  const ai = m.kind === "chat_ai";
  const who = out ? (ai ? "AI assistant" : m.agent_name || m.from_name || "Us") : m.from_name || t.customer_name || t.customer_email;
  return h("div", { class: "chat-msg" + (out ? " out" : "") + (ai ? " ai" : ""), "data-mid": m.id },
    h("div", { class: "chat-who" }, out ? null : h("span", { class: "avatar xs" }, initials(who)), ai ? [icon("spark"), " "] : null, who, h("span", { class: "chat-when", title: fullTime(m.sent_at) }, new Date(m.sent_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))),
    m.body_text ? h("div", { class: "chat-text" }, m.body_text) : null,
    chatCards(m),
    m.attachments?.length ? h("div", { class: "chat-photos" }, m.attachments.map((a) =>
      h("a", { href: fileUrl(a), target: "_blank", rel: "noopener" }, h("img", { src: fileUrl(a), alt: a.filename, loading: "lazy" })))) : null);
}

/** Articles and products the AI attached under its answer (what the customer saw as cards). */
function chatCards(m) {
  let c = m.cards;
  if (!c && m.extra) try { c = JSON.parse(m.extra); } catch { c = null; }
  if (!c || !(c.articles?.length || c.products?.length)) return null;
  return h("div", { class: "chat-cards" },
    (c.products ?? []).map((p) => h("a", { class: "chat-card", href: p.url, target: "_blank", rel: "noopener" }, h("b", {}, p.title), ` · ${p.price}`, p.why ? h("span", { class: "small muted" }, ` — ${p.why}`) : null)),
    (c.articles ?? []).map((a) => h("a", { class: "chat-card", href: a.url, target: "_blank", rel: "noopener" }, icon("note"), " ", a.title)));
}

/** The chat API's message shape → the ticket's message shape. */
const asMessage = (m) => ({
  id: m.id,
  direction: m.from === "visitor" ? "in" : "out",
  kind: m.from === "ai" ? "chat_ai" : m.from === "system" ? "chat_system" : "chat",
  body_text: m.text,
  attachments: m.files.map((f) => ({ id: f.id, filename: f.name, mimeType: f.mime })),
  sent_at: m.at,
  from_name: m.from === "visitor" ? m.name : null,
  agent_name: m.from === "agent" ? m.name : null,
  cards: m.cards ?? null,
});

/**
 * Live chat controls for a chat ticket. Returns { el, stop } — `el` replaces the email composer
 * while the chat is live; once it moves to email, `onEmail` swaps the normal composer back in.
 */
export function chatControls(t, data, thread, { onEmail, isCurrent }) {
  let lastId = Math.max(0, ...data.messages.filter((m) => m.kind).map((m) => m.id));
  let chat = null;
  let stopped = false;
  let timer;

  const statusEl = h("div", { class: "chat-status" });
  const draftEl = h("div");
  const box = h("textarea", { class: "chat-input", rows: 2, placeholder: "Reply in the chat…  (Enter to send, Shift+Enter for a new line)" });
  const fileIn = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
  const pending = [];
  const pendingEl = h("div", { class: "chat-pending" });
  const sendBtn = h("button", { class: "btn primary" }, icon("send"), "Send");
  const el = h("div", { class: "chat-composer" }, statusEl, draftEl, pendingEl,
    h("div", { class: "chat-row" },
      h("button", { class: "btn ghost icon-only", "aria-label": "Add photo", title: "Add photo", onclick: () => fileIn.click() }, icon("image")),
      box, sendBtn), fileIn);

  const drawPending = () => mount(pendingEl, pending.map((p, i) => h("span", { class: "chat-chip" }, icon("image"), p.name,
    h("button", { "aria-label": "Remove", onclick: () => { pending.splice(i, 1); drawPending(); } }, icon("x")))));
  fileIn.onchange = async () => {
    for (const f of [...fileIn.files].slice(0, 4)) {
      try { pending.push(await photoData(f)); } catch (e) { toast(e.message, true); }
    }
    fileIn.value = "";
    drawPending();
  };

  const drawStatus = () => {
    if (!chat) return;
    const here = chat.visitorOnline;
    const label = chat.state === "email" ? "Moved to email" : chat.state === "ended" ? "Chat ended" : here ? (chat.visitorTyping ? "typing…" : "on the site now") : "left the chat";
    const toEmail = h("button", { class: "btn sm ghost" }, icon("mail"), "Move to email");
    toEmail.onclick = busy(toEmail, async () => {
      if (!confirm(`Send ${chat.email} the chat so far and carry on by email?`)) return;
      const r = await api(`/chats/ticket/${t.id}/email`, { method: "POST" });
      chat = r.chat;
      await poll();
    });
    mount(statusEl,
      h("span", { class: "chat-dot" + (here ? " on" : "") }),
      h("span", {}, h("b", {}, chat.name || chat.email), " ", label),
      chat.state === "waiting" ? h("span", { class: "badge warn" }, "Waiting for a person") : null,
      chat.page ? h("a", { class: "small muted chat-page", href: chat.page, target: "_blank", rel: "noopener", title: chat.page }, "page") : null,
      h("span", { style: { flex: 1 } }),
      suggest,
      !["email", "ended"].includes(chat.state) ? toEmail : null);
    box.placeholder = here || chat.state === "agent" || chat.state === "waiting"
      ? "Reply in the chat…  (Enter to send, Shift+Enter for a new line)"
      : "They've left — your reply goes to them by email with the chat so far";
  };

  const drawDraft = () => {
    const d = chat?.draft;
    if (!d) return mount(draftEl);
    const use = h("button", { class: "btn sm primary" }, "Use this reply");
    use.onclick = () => { box.value = d.reply; box.focus(); };
    const sendNow = h("button", { class: "btn sm" }, icon("send"), "Send as is");
    sendNow.onclick = busy(sendNow, () => send(d.reply));
    const drop = h("button", { class: "btn sm ghost" }, "Dismiss");
    drop.onclick = busy(drop, async () => { await api(`/chats/ticket/${t.id}/discard-draft`, { method: "POST" }); chat.draft = null; drawDraft(); });
    mount(draftEl, h("div", { class: "chat-draft" },
      h("div", { class: "chat-draft-head" }, icon("spark"), h("b", {}, "AI suggestion"), d.handoff ? h("span", { class: "badge warn" }, "Needs a person") : null),
      h("div", { class: "chat-text" }, d.reply),
      d.reason ? h("div", { class: "small muted" }, d.reason) : null,
      h("div", { class: "row", style: { gap: "6px", marginTop: "8px" } }, sendNow, use, drop)));
  };

  const suggest = h("button", { class: "btn sm ghost" }, icon("spark"), "Suggest a reply");
  suggest.onclick = busy(suggest, async () => {
    suggest.replaceChildren(spinner(), "Thinking…");
    const r = await api(`/chats/ticket/${t.id}/suggest`, { method: "POST" });
    chat.draft = r.draft;
    drawDraft();
    suggest.replaceChildren(icon("spark"), "Suggest a reply");
  });

  async function send(text) {
    const body = { text: (text ?? box.value).trim(), files: pending.splice(0) };
    if (!body.text && !body.files.length) return;
    drawPending();
    try {
      const r = await api(`/chats/ticket/${t.id}/send`, { method: "POST", body });
      if (text === undefined) box.value = "";
      chat = r.chat;
      if (r.via === "email") toast("They'd left the chat, so your reply went by email with the chat so far");
      await poll();
    } catch (e) {
      toast(e.message, true);
    }
  }
  sendBtn.onclick = busy(sendBtn, () => send());
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendBtn.click(); }
  });
  let typed = 0;
  box.addEventListener("input", () => {
    if (Date.now() - typed < 3000) return;
    typed = Date.now();
    api(`/chats/ticket/${t.id}/typing`, { method: "POST" }).catch(() => {});
  });

  async function poll() {
    if (stopped) return;
    if (!isCurrent()) return stop();
    try {
      const r = await api(`/chats/ticket/${t.id}?after=${lastId}`);
      const wasState = chat?.state;
      const hadDraft = JSON.stringify(chat?.draft ?? null);
      chat = r.chat;
      if (r.messages.length) {
        const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
        for (const m of r.messages) {
          if (thread.querySelector(`[data-mid="${m.id}"]`)) continue;
          thread.append(chatBubble(t, asMessage(m)));
          lastId = Math.max(lastId, m.id);
        }
        if (nearBottom) thread.scrollTop = thread.scrollHeight;
      }
      drawStatus();
      if (JSON.stringify(chat.draft ?? null) !== hadDraft) drawDraft();
      if (chat.state === "email" && wasState !== "email") onEmail();
    } catch { /* keep trying */ }
    clearTimeout(timer);
    // Fast while the customer is here; slow once it's moved on
    const live = chat && !["email", "ended"].includes(chat.state);
    timer = setTimeout(poll, live ? (document.hidden ? 8000 : 2500) : 20000);
  }
  function stop() {
    stopped = true;
    clearTimeout(timer);
  }
  // First look once the ticket is on screen (it's built before it's mounted)
  setTimeout(poll, 0);
  return { el, stop, current: () => chat };
}
