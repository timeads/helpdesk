// Settings → Instagram & Facebook: the Meta app keys, the addresses to paste into the Meta app,
// Facebook Login to pick the Page (and its Instagram account), and what becomes a ticket.
import { api } from "./api.js";
import { h, mount, toast, busy, icon, relTime } from "./ui.js";

export function socialCard() {
  const el = h("section", { class: "card", id: "social" }, h("h2", {}, "Instagram & Facebook"), h("p", { class: "muted" }, "Loading…"));
  const load = () => Promise.all([api("/social/status"), api("/credentials")])
    .then(([s, creds]) => draw(el, s, creds.fields.filter((f) => f.group === "meta"), load))
    .catch((e) => mount(el, h("h2", {}, "Instagram & Facebook"), h("div", { class: "notice bad" }, e.message)));
  load();
  return el;
}

const RESULT = {
  connected: ["good", "Connected — new comments and messages will show up as tickets."],
  cancelled: ["bad", "Facebook Login was cancelled — nothing changed."],
  expired: ["bad", "That sign-in took too long — click Connect again."],
  nopages: ["bad", "Facebook didn't share any Pages. Click Connect again and, on the Facebook screen, choose your Page (and its Instagram account) under “Edit access”."],
  pick: ["info", "You manage more than one Page — pick the one for Tuft the World below."],
};

function draw(el, s, fields, reload) {
  const q = new URLSearchParams(location.search);
  const result = q.get("meta");
  const banner = result === "error"
    ? h("div", { class: "notice bad" }, `Couldn't connect: ${q.get("message") || "unknown error"}`)
    : RESULT[result] ? h("div", { class: `notice ${RESULT[result][0]}` }, RESULT[result][1]) : null;
  if (result) history.replaceState(null, "", location.pathname);

  // ---- 1. The Meta app's keys
  const idField = fields.find((f) => f.key === "META_APP_ID");
  const secretField = fields.find((f) => f.key === "META_APP_SECRET");
  const appId = h("input", { class: "input", value: idField?.value || "", autocomplete: "off", spellcheck: false, placeholder: "15–16 digits" });
  const secret = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: false, placeholder: secretField?.set ? `Saved (${secretField.hint}) — type to replace` : "" });
  const keyResult = h("div", { class: "small", role: "status" });
  const saveKeys = h("button", { class: "btn" + (s.configured ? "" : " primary") }, "Save & check");
  saveKeys.onclick = busy(saveKeys, async () => {
    const body = { META_APP_ID: appId.value.trim() };
    if (secret.value.trim()) body.META_APP_SECRET = secret.value.trim();
    await api("/credentials", { method: "PUT", body });
    secret.value = "";
    const r = await api("/credentials/test/meta", { method: "POST" });
    if (!r.ok) return mount(keyResult, h("span", { class: "badge bad", style: { height: "auto", whiteSpace: "normal", padding: "3px 9px" } }, r.message));
    toast(r.message);
    reload();
  });

  // ---- 2. Addresses to paste into the Meta app
  const copyRow = (label, value, help) => {
    const b = h("button", { class: "btn sm", type: "button" }, icon("copy"), "Copy");
    b.onclick = async () => { try { await navigator.clipboard.writeText(value); toast(`${label} copied`); } catch { toast("Select it and copy", true); } };
    return h("div", { class: "field" }, h("span", {}, label),
      h("div", { class: "row", style: { flexWrap: "nowrap", gap: "6px" } }, h("input", { class: "input", value, readonly: true, onfocus: (e) => e.target.select() }), b),
      help ? h("span", { class: "muted", style: { fontWeight: 400 } }, help) : null);
  };

  // ---- 3. Connection
  const c = s.connection;
  const connect = h("a", { class: "btn" + (c ? "" : " primary"), href: "/api/social/connect" }, icon(c ? "refresh" : "link"), c ? "Reconnect" : "Connect Facebook & Instagram");
  const disconnect = h("button", { class: "btn ghost danger sm" }, "Disconnect");
  disconnect.onclick = busy(disconnect, async () => {
    if (!confirm("Disconnect Instagram & Facebook? Tickets stay; new comments and messages stop coming in.")) return;
    await api("/social/disconnect", { method: "POST" });
    reload();
  });
  const resub = h("button", { class: "btn sm" }, "Check webhooks again");
  resub.onclick = busy(resub, async () => {
    const r = await api("/social/resubscribe", { method: "POST" });
    toast(r.subscribed.page && !r.subscribed.app ? "Meta is sending comments and messages here" : "Meta didn't accept every subscription — see the note below", !(r.subscribed.page && !r.subscribed.app));
    reload();
  });
  const pickPage = (p) => {
    const b = h("button", { class: "btn" }, h("b", {}, p.name), p.igUsername ? h("span", { class: "muted" }, ` · @${p.igUsername}`) : h("span", { class: "muted" }, " · no Instagram linked"));
    b.onclick = busy(b, async () => { await api(`/social/pages/${encodeURIComponent(p.id)}`, { method: "POST" }); toast(`Connected ${p.name}`); reload(); });
    return b;
  };
  const status = c
    ? h("div", { class: "integration" },
        h("span", { class: "logo" }, icon("instagram"), h("span", { class: "dot on" })),
        h("div", { class: "info" },
          h("div", { class: "name" }, c.pageName, c.igUsername ? h("span", { class: "muted", style: { fontWeight: 500 } }, ` · @${c.igUsername}`) : null),
          h("div", { class: "muted" }, s.lastEvent ? `Last comment or message ${relTime(s.lastEvent)} ago` : "Connected — waiting for the first comment or message"),
          !c.igUsername ? h("div", { class: "small", style: { color: "var(--ochre-text)" } }, "No Instagram account is linked to this Page — link it in Instagram (Settings → Account type and tools → Linked Facebook Page), then Reconnect.") : null,
          !c.subscribed?.page || c.subscribed?.app ? h("div", { class: "small", style: { color: "var(--red)" } },
            `Meta didn't accept the webhook subscription${c.subscribed?.app ? `: ${c.subscribed.app}` : ""}. Add the webhook below by hand in the Meta app (Webhooks → Page and Instagram), then click “Check webhooks again”.`) : null),
        h("div", { class: "row" }, resub, connect, disconnect))
    : s.pending.length
      ? h("div", { class: "stack" }, h("b", {}, "Which Page is the store's?"), h("div", { class: "row" }, s.pending.map(pickPage)))
      : h("div", { class: "row" }, s.configured ? connect : h("span", { class: "muted small" }, "Save the App ID and secret first."));

  // ---- 4. What becomes a ticket
  const st = { ...s.settings };
  const saveSet = h("button", { class: "btn save-btn" }, "Save");
  saveSet.onclick = busy(saveSet, async () => { await api("/social/settings", { method: "PUT", body: st }); saveSet.classList.remove("primary"); toast("Saved"); });
  const check = (key, label, desc) => {
    const x = h("input", { type: "checkbox", checked: !!st[key] });
    x.onchange = () => { st[key] = x.checked; saveSet.classList.add("primary"); };
    return h("label", { class: "check" }, x, h("span", {}, label, desc ? h("div", { class: "small muted" }, desc) : null));
  };

  const step = (n, title, ...body) => h("div", { class: "macro-row" }, h("h3", { class: "section", style: { margin: 0 } }, `${n}. ${title}`), ...body);
  mount(el,
    h("h2", {}, "Instagram & Facebook"),
    h("p", { class: "muted" }, "Comments on your posts and direct messages become tickets. Reply from here — publicly under the comment, privately, or by DM — with suggested replies from your guides."),
    banner,
    step(1, "Your Meta app", h("p", { class: "muted small", style: { margin: 0 } }, "Meta for Developers → your app → App settings → Basic."),
      h("div", { class: "grid2 cred-grid" },
        h("label", { class: "field" }, "App ID", appId),
        h("label", { class: "field" }, "App secret", secret)),
      h("div", { class: "row" }, saveKeys, keyResult)),
    step(2, "Paste these into the Meta app",
      copyRow("Valid OAuth Redirect URI", s.redirectUri, "Facebook Login for Business → Settings → Valid OAuth Redirect URIs"),
      copyRow("Webhook callback URL", s.webhookUrl, "Webhooks — set up for you when you connect; only needed if Meta asks"),
      copyRow("Webhook verify token", s.verifyToken, null)),
    step(3, "Connect", status),
    step(4, "What becomes a ticket",
      h("div", { class: "grid2" },
        check("igComments", "Instagram comments"), check("igDms", "Instagram DMs"),
        check("fbComments", "Facebook comments"), check("fbDms", "Facebook Messenger")),
      check("skipNoise", "Skip emoji-only and tag-only comments", "“😍🔥”, “@friend look!” and one-word reactions don't start a ticket (they still show if the person is already talking to you)."),
      h("div", { class: "row" }, saveSet)));
}
