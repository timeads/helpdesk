import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, relTime, toast, busy, icon, skeletonRows } from "./ui.js";

export function renderSettings(main) {
  const inner = h("div", { class: "page-inner", style: { maxWidth: "880px" } }, h("div", { class: "card" }, skeletonRows(4)));
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner", style: { maxWidth: "880px", paddingBottom: "4px" } },
      h("h1", {}, "Settings"),
      h("p", { class: "sub" }, "Connections, team, saved replies and shipping defaults."))),
    inner));
  load(inner);
  return () => {};
}

async function load(inner) {
  let s, agents, macros, presets;
  try {
    [s, { agents }, { macros }, { presets }] = await Promise.all([
      api("/settings"), api("/agents"), api("/macros"), api("/shipping/presets"),
    ]);
  } catch (e) {
    return mount(inner, h("div", { class: "notice bad" }, e.message));
  }
  const isAdmin = state.me.role === "admin";
  inner.oninput = markDirty;
  inner.onchange = markDirty;
  if (new URLSearchParams(location.search).get("connected") === "gmail") toast("Gmail connected — importing recent mail");
  mount(inner,
    connections(s, isAdmin, inner),
    profile(),
    team(agents, isAdmin, inner),
    savedReplies(macros, inner),
    isAdmin ? mailRules(s) : null,
    isAdmin ? shipping(s, presets, inner) : null,
    isAdmin && s.integrations.ai.connected ? aiGuidance(s) : null,
  );
}

const reload = (inner) => load(inner);

function card(title, desc, ...children) {
  return h("section", { class: "card" }, h("h2", {}, title), desc ? h("p", { class: "muted" }, desc) : null, ...children);
}

// Save buttons stay quiet until their form changes, so each screen has at most one ochre action.
function saveButton(fn, label = "Save") {
  const b = h("button", { class: "btn save-btn" }, label);
  b.onclick = busy(b, async () => {
    await fn();
    b.classList.remove("primary");
    toast("Saved");
  });
  return b;
}

function markDirty(e) {
  const scope = e.target.closest(".macro-row, .card");
  scope?.querySelectorAll(".save-btn").forEach((b) => {
    if (b.closest(".macro-row, .card") === scope) b.classList.add("primary");
  });
}

function connections(s, isAdmin, inner) {
  const i = s.integrations;
  const gmailInfo = i.gmail.connected
    ? [h("div", {}, i.gmail.email), h("div", { class: "muted" }, i.gmail.lastSyncAt ? `Last checked ${relTime(i.gmail.lastSyncAt)} ago` : "Waiting for first sync"),
       i.gmail.lastError ? h("div", { style: { color: "var(--red)" } }, i.gmail.lastError) : null]
    : [h("div", { class: "muted" }, i.gmail.configured ? `Connect ${i.gmail.email} to start turning email into tickets.` : "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see README).")];
  const syncBtn = h("button", { class: "btn sm" }, "Check now");
  syncBtn.onclick = busy(syncBtn, async () => {
    const r = await api("/tickets/sync", { method: "POST" });
    toast(`Imported ${r.imported} message${r.imported === 1 ? "" : "s"}`);
    reload(inner);
  });
  const disconnect = h("button", { class: "btn sm ghost danger" }, "Disconnect");
  disconnect.onclick = busy(disconnect, async () => {
    if (!confirm("Disconnect the support mailbox? Tickets stay; new mail stops coming in.")) return;
    await api("/mailbox/disconnect", { method: "POST" });
    reload(inner);
  });
  const row = (name, on, err, info, actions, iconName) =>
    h("div", { class: "integration" },
      h("span", { class: "logo" }, icon(iconName), h("span", { class: "dot" + (err ? " err" : on ? " on" : "") })),
      h("div", { class: "info" }, h("div", { class: "name" }, name), info),
      h("div", { class: "row" }, actions));
  return card("Connections", null,
    row("Gmail", i.gmail.connected, i.gmail.lastError, gmailInfo,
      i.gmail.connected ? [syncBtn, isAdmin ? disconnect : null]
        : isAdmin && i.gmail.configured ? h("a", { class: "btn sm primary", href: "/auth/mailbox" }, "Connect Gmail") : null, "mail"),
    row("Shopify", i.shopify.connected, false, h("div", { class: "muted" }, i.shopify.connected ? i.shopify.shop : "Add Shopify app credentials as secrets (see README)."), null, "bag"),
    row("UPS", i.ups.connected, false, h("div", { class: "muted" }, i.ups.connected ? (i.ups.env === "production" ? "Live — labels are billed to your UPS account" : "Test mode — labels are not billed") : "Add UPS API credentials as secrets (see README)."), null, "truck"),
    row("AI drafts", i.ai.connected, false, h("div", { class: "muted" }, i.ai.connected ? `On · ${i.ai.model}` : "Optional. Add ANTHROPIC_API_KEY to show a “Draft with AI” button."), null, "spark"),
  );
}

function profile() {
  const name = h("input", { class: "input", value: state.me.name });
  const sig = h("textarea", { class: "input", rows: 4, placeholder: "Leave blank to use the team signature" }, state.me.signature || "");
  sig.value = state.me.signature || "";
  return card("Your profile", "Your name shows on replies in the ticket view. Your signature is added to every email you send.",
    h("div", { class: "stack" },
      h("label", { class: "field" }, "Name", name),
      h("label", { class: "field" }, "Signature", sig),
      h("div", {}, saveButton(async () => {
        await api("/me", { method: "PATCH", body: { name: name.value, signature: sig.value } });
        state.me.name = name.value;
        state.me.signature = sig.value;
      }))));
}

function team(agents, isAdmin, inner) {
  const email = h("input", { class: "input", type: "email", placeholder: "name@tufttheworld.com" });
  const name = h("input", { class: "input", placeholder: "Name" });
  const role = h("select", { class: "input" }, h("option", { value: "agent" }, "Agent"), h("option", { value: "admin" }, "Admin"));
  const add = h("button", { class: "btn save-btn" }, "Add");
  add.onclick = busy(add, async () => {
    await api("/agents", { method: "POST", body: { email: email.value, name: name.value, role: role.value } });
    toast(`${email.value} can now sign in with Google`);
    reload(inner);
  });
  return card("Team", "Anyone listed here can sign in with their Google account and be assigned tickets.",
    h("table", { class: "tbl" }, h("tbody", {}, agents.map((a) => {
      const rm = h("button", { class: "btn sm ghost danger" }, "Remove");
      rm.onclick = busy(rm, async () => {
        if (!confirm(`Remove ${a.name}? Their open tickets become unassigned.`)) return;
        await api(`/agents/${a.id}`, { method: "DELETE" });
        reload(inner);
      });
      return h("tr", {}, h("td", {}, h("b", {}, a.name)), h("td", { class: "muted" }, a.email), h("td", {}, h("span", { class: "badge" }, a.role)),
        h("td", { style: { textAlign: "right" } }, isAdmin && a.id !== state.me.id ? rm : null));
    }))),
    isAdmin ? h("div", { class: "grid4", style: { marginTop: "12px", gridTemplateColumns: "2fr 1.4fr 1fr auto" } }, email, name, role, add) : null);
}

function savedReplies(macros, inner) {
  const list = h("div", { class: "stack" });
  const editor = (m = { name: "", body: "" }) => {
    const name = h("input", { class: "input", value: m.name, placeholder: "Name, e.g. Where is my order" });
    const body = h("textarea", { class: "input", rows: 5, placeholder: "Hi {{first_name}}, …" });
    body.value = m.body;
    const save = saveButton(async () => {
      if (m.id) await api(`/macros/${m.id}`, { method: "PUT", body: { name: name.value, body: body.value } });
      else await api("/macros", { method: "POST", body: { name: name.value, body: body.value } });
      reload(inner);
    });
    const del = m.id ? h("button", { class: "btn ghost danger" }, "Delete") : null;
    if (del) del.onclick = busy(del, async () => {
      if (!confirm(`Delete “${m.name}”?`)) return;
      await api(`/macros/${m.id}`, { method: "DELETE" });
      reload(inner);
    });
    return h("div", { class: "macro-row" }, name, body, h("div", { class: "row" }, save, del));
  };
  macros.forEach((m) => list.append(editor(m)));
  const addBtn = h("button", { class: "btn" }, icon("plus"), "New saved reply");
  addBtn.onclick = () => { list.prepend(editor()); addBtn.remove(); };
  return card("Saved replies", "Insert from the composer. {{first_name}} and {{agent_name}} are filled in automatically.", h("div", { style: { marginBottom: "10px" } }, addBtn), list);
}

function mailRules(s) {
  const r = s.mailRules;
  const blocked = h("textarea", { class: "input", rows: 3, placeholder: "One per line: someone@example.com or @example.com" });
  blocked.value = r.blockedSenders.join("\n");
  const skip = h("input", { type: "checkbox", checked: r.skipAutomated });
  const archive = h("input", { type: "checkbox", checked: r.archiveOnClose });
  const days = h("input", { class: "input", type: "number", min: 1, max: 90, value: r.importDays, style: { width: "90px" } });
  const sig = h("textarea", { class: "input", rows: 3 });
  sig.value = s.signature;
  return card("Email", null,
    h("div", { class: "stack" },
      h("label", { class: "field" }, "Team signature (used when an agent has none)", sig),
      h("label", { class: "check" }, skip, "Ignore newsletters, mailing lists and auto-replies (they won't become tickets)"),
      h("label", { class: "check" }, archive, "Archive the Gmail thread when a ticket is closed"),
      h("label", { class: "field" }, "Never make tickets from", blocked),
      h("label", { class: "field" }, "On first connect, import mail from the last N days", days),
      h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: {
        signature: sig.value,
        mailRules: { blockedSenders: blocked.value.split("\n"), skipAutomated: skip.checked, archiveOnClose: archive.checked, importDays: Number(days.value) },
      } })))));
}

function shipping(s, presets, inner) {
  const a = s.shipFrom || { name: "", company: "Tuft the World", phone: "", address1: "", address2: "", city: "", state: "", zip: "", country: "US" };
  const f = (label, key, attrs = {}) => {
    const i = h("input", { class: "input", value: a[key] ?? "", ...attrs });
    i.oninput = () => (a[key] = i.value);
    return h("label", { class: "field" }, label, i);
  };
  const presetRows = presets.map((p) => {
    const del = h("button", { class: "btn sm ghost danger" }, "Remove");
    del.onclick = busy(del, async () => { await api(`/shipping/presets/${p.id}`, { method: "DELETE" }); reload(inner); });
    return h("tr", {}, h("td", {}, p.name), h("td", { class: "muted" }, `${p.length} × ${p.width} × ${p.height} in`), h("td", { class: "muted" }, `${p.weight} lb empty`), h("td", { style: { textAlign: "right" } }, del));
  });
  const np = { name: "", length: "", width: "", height: "", weight: "" };
  const pi = (key, ph, type = "number") => { const i = h("input", { class: "input", placeholder: ph, type, step: "0.1" }); i.oninput = () => (np[key] = i.value); return i; };
  const addPreset = h("button", { class: "btn" }, icon("plus"), "Add box");
  addPreset.onclick = busy(addPreset, async () => { await api("/shipping/presets", { method: "POST", body: np }); reload(inner); });
  return card("Shipping", "The return address printed on every UPS label, and the boxes you ship in.",
    h("div", { class: "stack" },
      h("div", { class: "grid2" }, f("Contact name", "name"), f("Company", "company")),
      h("div", { class: "grid2" }, f("Address", "address1"), f("Suite / unit", "address2")),
      h("div", { class: "grid4" }, f("City", "city"), f("State", "state", { maxlength: 2 }), f("ZIP", "zip"), f("Country", "country", { maxlength: 2 })),
      h("div", { class: "grid2" }, f("Phone (required by UPS)", "phone"), h("span")),
      h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: { shipFrom: a } }), "Save address")),
      h("h3", { class: "section" }, "Box sizes"),
      h("table", { class: "tbl" }, h("tbody", {}, presetRows)),
      h("div", { class: "parcel", style: { gridTemplateColumns: "2fr repeat(4, 1fr) auto" } },
        pi("name", "Box name", "text"), pi("length", "L"), pi("width", "W"), pi("height", "H"), pi("weight", "Empty lb"), addPreset)));
}

function aiGuidance(s) {
  const g = h("textarea", { class: "input", rows: 8, placeholder: "e.g. Returns accepted within 30 days, unused. Orders ship in 1–2 business days from Philadelphia. Offer a free replacement for damaged items with a photo. Never promise delivery dates." });
  g.value = s.aiGuidance;
  return card("AI guidance", "Store policies and tone notes the AI follows when drafting replies.",
    h("div", { class: "stack" }, g, h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: { aiGuidance: g.value } })))));
}
