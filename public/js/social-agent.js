// An Instagram or Facebook ticket: the post the comment is on, suggested replies, and a reply box that
// answers under their comment, privately about it, or by direct message (within Meta's 24-hour window).
import { api } from "./api.js";
import { navigate } from "./app.js";
import { h, mount, icon, toast, busy, spinner } from "./ui.js";

const NAME = { instagram: "Instagram", facebook: "Facebook" };

export function socialControls(inbox, t, thread) {
  const el = h("div", { class: "social-composer" }, h("div", { class: "row" }, spinner(), h("span", { class: "muted small" }, "Loading…")));
  api(`/social/ticket/${t.id}`).then((s) => {
    const post = postCard(s);
    if (post) thread.prepend(post);
    draw(el, inbox, t, s);
  }).catch((e) => mount(el, h("div", { class: "notice bad" }, e.message)));
  return { el };
}

/** The post a comment is on (shown above the conversation). */
export function postCard(s) {
  if (!s.post) return null;
  return h("a", { class: "social-post", href: s.post.url || "#", target: "_blank", rel: "noopener" },
    s.post.image ? h("img", { src: s.post.image, alt: "", loading: "lazy" }) : h("span", { class: "social-post-ph" }, icon(s.platform)),
    h("div", { class: "social-post-text" },
      h("div", { class: "small muted" }, icon(s.platform), ` Comment on your ${NAME[s.platform]} post`),
      s.post.caption ? h("div", { class: "social-caption" }, s.post.caption) : null,
      s.post.url ? h("span", { class: "small" }, "View post ", icon("ext")) : null));
}

function draw(el, inbox, t, s) {
  const o = s.options;
  const box = h("textarea", { class: "chat-input", rows: 3, placeholder: "Write a reply…" });
  const counter = h("span", { class: "small muted" });
  // Which ways a reply can go, primary first
  const ways = [
    o.dm ? { via: "dm", label: "Send DM", icon: "send", ok: o.dmOpen, why: "It's been more than 24 hours since their last message — Meta only delivers DMs within 24 hours. Reply publicly, or wait for them to write again." } : null,
    o.public ? { via: "public", label: "Reply publicly", icon: "reply", ok: true } : null,
    o.private ? { via: "private", label: "Reply privately", icon: "mail", ok: true, title: "Sends them a DM about this comment (once per comment). Their answer comes back to this ticket." } : null,
  ].filter(Boolean);
  let via = (ways.find((w) => w.ok) ?? ways[0])?.via;
  const limit = () => (via === "public" ? 2200 : 1000);
  const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "How to send" });
  const note = h("div", { class: "small muted social-note" });
  const drawWays = () => {
    mount(seg, ways.map((w) => h("button", {
      type: "button", class: via === w.via ? "on" : "", role: "radio", "aria-checked": via === w.via, title: w.title || null,
      onclick: () => { via = w.via; drawWays(); },
    }, icon(w.icon), w.label)));
    const w = ways.find((x) => x.via === via);
    note.textContent = !w ? "" : !w.ok ? w.why
      : via === "public" ? `Everyone can see this under their comment on ${NAME[s.platform]}. Keep order details for a private reply or DM.`
      : via === "private" ? "Goes to their inbox as a message about this comment. You can send one per comment."
      : o.dmClosesAt ? `You can message them until ${new Date(o.dmClosesAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} (24 hours after their last message).` : "";
    sendBtn.disabled = closeBtn.disabled = !w?.ok;
    countDraw();
  };
  const countDraw = () => {
    const n = box.value.length;
    counter.textContent = n > limit() * 0.8 ? `${n} / ${limit()}` : "";
    counter.style.color = n > limit() ? "var(--red)" : "";
  };
  box.oninput = countDraw;
  const send = async (close) => {
    const text = box.value.trim();
    if (!text) return toast("Write a reply first", true);
    if (text.length > limit()) return toast(`That's over ${NAME[s.platform]}'s ${limit()}-character limit`, true);
    await api(`/social/ticket/${t.id}/send`, { method: "POST", body: { text, via } });
    if (close) await api(`/tickets/${t.id}`, { method: "PATCH", body: { status: "closed" } });
    toast(via === "public" ? "Replied under their comment" : "Message sent");
    box.value = "";
    if (close && inbox.goNext) inbox.goNext(t.id);
    else if (close) navigate(`/?view=${inbox.view}`);
    else navigate(`/tickets/${t.id}?view=${inbox.view}`, { replace: true });
  };
  const sendBtn = h("button", { class: "btn primary" }, icon("send"), "Send");
  const closeBtn = h("button", { class: "btn" }, "Send & close");
  sendBtn.onclick = busy(sendBtn, () => send(false));
  closeBtn.onclick = busy(closeBtn, () => send(true));
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.shiftKey ? closeBtn : sendBtn).click(); }
  });

  const suggestEl = h("div", { class: "suggest", hidden: true });
  loadSuggestions(t, suggestEl, (text) => { box.value = text; countDraw(); box.focus(); });

  mount(el,
    !s.connected ? h("div", { class: "notice bad" }, "Instagram & Facebook aren't connected — replies can't be sent until they're connected again in Settings.") : null,
    suggestEl,
    h("div", { class: "social-box" },
      h("div", { class: "social-head" }, h("span", { class: `social-badge ${s.platform}` }, icon(s.platform), NAME[s.platform]), seg),
      box,
      h("div", { class: "social-bar" }, note, h("div", { class: "grow" }), counter, closeBtn, sendBtn)));
  drawWays();
}

/** The AI's reply options for the latest message (same as email tickets, written for the platform). */
async function loadSuggestions(t, el, use) {
  const show = (s) => {
    if (!s?.options?.length) return (el.hidden = true);
    el.hidden = false;
    mount(el, h("div", { class: "suggest-head" }, icon("spark"), h("b", {}, "Suggested replies"), h("span", { class: "small muted" }, "pick one, edit, then send")),
      h("div", { class: "suggest-cards" }, s.options.map((o, i) => h("button", { type: "button", class: "suggest-card", onclick: () => {
        use(o.body);
        el.querySelectorAll(".suggest-card").forEach((c, j) => c.classList.toggle("on", j === i));
        api(`/tickets/${t.id}/suggestions/used`, { method: "POST", body: { index: i } }).catch(() => {});
      } }, h("span", { class: "suggest-label" }, o.label), h("span", { class: "suggest-preview" }, o.body.slice(0, 220))))));
  };
  try {
    const r = await api(`/tickets/${t.id}/suggestions`);
    if (r.current && r.suggestion?.status === "ready") return show(r.suggestion);
    if (!r.on || !["open", "in_progress"].includes(t.status)) return;
    if (r.current && r.suggestion?.status === "working") { setTimeout(() => el.isConnected && loadSuggestions(t, el, use), 4000); return; }
    el.hidden = false;
    mount(el, h("div", { class: "suggest-head" }, icon("spark"), h("b", {}, "Writing suggested replies…"), spinner()));
    show((await api(`/tickets/${t.id}/suggestions`, { method: "POST" })).suggestion);
  } catch {
    el.hidden = true;
  }
}
