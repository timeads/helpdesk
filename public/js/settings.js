import { api } from "./api.js";
import { state } from "./app.js";
import { h, mount, relTime, toast, busy, icon, skeletonRows, initials, growInput } from "./ui.js";
import { printSettings, savePrintSettings, testZebra, zebraPrinter } from "./printing.js";
import { supportBehavior, macrosCard, tagsCard, viewsCard, supportRulesCard, knowledgeCard } from "./settings-support.js";

export function renderSettings(main) {
  const inner = h("div", { class: "page-inner", style: { maxWidth: "880px" } }, h("div", { class: "card" }, skeletonRows(4)));
  mount(main, h("div", { class: "page" },
    h("header", { class: "page-head" }, h("div", { class: "inner", style: { maxWidth: "880px", paddingBottom: "4px" } },
      h("h1", {}, "Settings"),
      h("p", { class: "sub" }, "Connections, team, support automation and shipping defaults."),
      h("nav", { class: "settings-nav", "aria-label": "Settings sections" }, [["connections", "Connections"], ["team", "Team"], ["support", "Tickets"], ["macros", "Macros"], ["tags", "Tags"], ["views", "Views"], ["rules", "Rules"], ["knowledge", "AI knowledge"], ["email", "Email"], ["shipping", "Shipping"], ["customs", "Customs"], ["printing", "Printing"]]
        .map(([id, label]) => h("a", { href: `#${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); history.replaceState(null, "", `#${id}`); } }, label))))),
    inner));
  load(inner);
  return () => {};
}

async function load(inner) {
  let s, agents, macros, variables, presets, creds = null, rulesData = null, tags, views, supportRules, knowledge;
  const isAdminUser = state.me.role === "admin";
  try {
    [s, { agents }, { macros, variables }, { presets }, creds, rulesData, { tags }, { views }, supportRules, { knowledge }] = await Promise.all([
      api("/settings"), api("/agents"), api("/macros"), api("/shipping/presets"),
      isAdminUser ? api("/credentials") : null,
      isAdminUser ? api("/shipping/rules") : null,
      api("/tags"), api("/views"), api("/support-rules"), api("/knowledge"),
    ]);
  } catch (e) {
    return mount(inner, h("div", { class: "notice bad" }, e.message));
  }
  const isAdmin = state.me.role === "admin";
  if (location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  inner.oninput = markDirty;
  inner.onchange = markDirty;
  if (new URLSearchParams(location.search).get("connected") === "gmail") toast("Gmail connected — importing recent mail");
  mount(inner,
    connections(s, isAdmin, inner),
    isAdmin && creds ? credentials(creds.fields, inner) : null,
    printing(),
    profile(),
    team(agents, isAdmin, inner),
    isAdmin ? supportBehavior(s) : null,
    macrosCard(macros, variables, () => reload(inner)),
    tagsCard(tags, () => reload(inner)),
    viewsCard(views, tags, () => reload(inner)),
    isAdmin ? supportRulesCard(supportRules, macros, tags, () => reload(inner)) : null,
    knowledgeCard(knowledge, () => reload(inner)),
    isAdmin ? mailRules(s) : null,
    isAdmin ? shipping(s, presets, inner) : null,
    isAdmin && rulesData ? shippingRules(rulesData, presets, inner) : null,
    isAdmin ? customsCard(s) : null,
  );
}

const reload = (inner) => load(inner);

const CARD_IDS = { Connections: "connections", Team: "team", Email: "email", Shipping: "shipping", "Shipping rules": "shipping-rules", Credentials: "credentials", "Your profile": "profile" };
function card(title, desc, ...children) {
  return h("section", { class: "card", id: CARD_IDS[title] }, h("h2", {}, title), desc ? h("p", { class: "muted" }, desc) : null, ...children);
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
       i.gmail.catchingUp ? h("div", { class: "small", style: { color: "var(--ochre-text)" } }, "Still importing — about 40 emails a minute until it's caught up") : null,
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
    row("Shopify", i.shopify.connected, false, h("div", { class: "muted" }, i.shopify.connected ? i.shopify.shop : "Add your Shopify app keys under Credentials below."), null, "bag"),
    row("UPS", i.ups.connected, false, h("div", { class: "muted" }, i.ups.connected ? (i.ups.env === "production" ? "Live — labels are billed to your UPS account" : "Test mode — labels are not billed") : "Add your UPS keys under Credentials below."), null, "truck"),
    row("AI drafts", i.ai.connected, false, h("div", { class: "muted" }, i.ai.connected ? `On · ${i.ai.model}` : "Optional. Add an Anthropic key under Credentials to turn on “Draft with AI”."), null, "spark"),
  );
}

const GROUPS = [
  { id: "shopify", title: "Shopify", desc: "From the Helpdesk app you created in Shopify. Use a Client ID + secret (Dev Dashboard) or an Admin API token (older custom apps)." },
  { id: "ups", title: "UPS", desc: "From your app at developer.ups.com. Keep Mode on “test” until a test label prints correctly." },
  { id: "usps", title: "USPS (EasyPost)", desc: "From easypost.com → Account → API Keys. Use the Production key; postage is paid from your EasyPost wallet (fund it by ACH to avoid the card fee)." },
  { id: "ai", title: "AI drafts", desc: "Optional. A key from console.anthropic.com turns on “Draft with AI” (about 1–2¢ per draft)." },
];

function credentials(fields, inner) {
  const sections = GROUPS.map((g) => {
    const inputs = {};
    const result = h("div", { class: "small", role: "status" });
    const rows = fields.filter((f) => f.group === g.id).map((f) => {
      let input;
      if (f.options) {
        input = h("select", { class: "input" }, f.options.map((o) => h("option", { value: o, selected: (f.value || f.options[0]) === o }, o)));
      } else if (f.secret) {
        input = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: false,
          placeholder: f.set ? `Saved (${f.hint}) — type to replace` : f.placeholder || "" });
      } else {
        input = h("input", { class: "input", value: f.value || "", autocomplete: "off", spellcheck: false, placeholder: f.placeholder || "" });
      }
      inputs[f.key] = input;
      const clear = f.source === "app" && f.secret
        ? h("button", { class: "btn sm ghost danger", type: "button", onclick: async () => {
            await api("/credentials", { method: "PUT", body: { [f.key]: "" } });
            toast(`${f.label} removed`);
            reload(inner);
          } }, "Remove")
        : null;
      return h("label", { class: "field" },
        h("span", { class: "row", style: { gap: "6px", minHeight: "21px" } }, f.label,
          f.source === "cloudflare" && f.secret ? h("span", { class: "badge plain" }, "set in Cloudflare") : null),
        clear ? h("span", { class: "row", style: { flexWrap: "nowrap", gap: "6px" } }, input, clear) : input,
        f.help ? h("span", { class: "muted", style: { fontWeight: 400 } }, f.help) : null);
    });
    const save = saveButton(async () => {
      const body = {};
      for (const [k, input] of Object.entries(inputs)) {
        const f = fields.find((x) => x.key === k);
        if (f.secret && !input.value) continue; // blank secret = keep the saved one
        body[k] = input.value;
      }
      await api("/credentials", { method: "PUT", body });
      for (const [k, input] of Object.entries(inputs)) if (fields.find((x) => x.key === k).secret) input.value = "";
      await runTest();
    });
    const test = h("button", { class: "btn", type: "button" }, "Test connection");
    const runTest = async () => {
      result.replaceChildren(h("span", { class: "muted" }, "Checking…"));
      const r = await api(`/credentials/test/${g.id}`, { method: "POST" });
      result.replaceChildren(h("span", { class: "badge " + (r.ok ? "good" : "bad"), style: { height: "auto", whiteSpace: "normal", padding: "3px 9px" } }, r.message));
    };
    test.onclick = busy(test, runTest);
    return h("div", { class: "macro-row" },
      h("h3", { class: "section", style: { margin: 0 } }, g.title),
      h("p", { class: "muted small", style: { margin: 0, fontFamily: "var(--read)" } }, g.desc),
      h("div", { class: "grid2 cred-grid" }, rows),
      h("div", { class: "row" }, save, test, result));
  });
  return card("Credentials", "Paste the keys for each service here. They're encrypted before they're stored, and saved secrets are never shown again — only their last four characters.", ...sections);
}

function printing() {
  const ps = printSettings();
  const status = h("div", { class: "small", role: "status" });
  const radio = (name, value, label, desc) => {
    const r = h("input", { type: "radio", name, value, checked: ps[name] === value });
    r.onchange = () => { savePrintSettings({ [name]: value }); toast("Saved for this computer"); };
    return h("label", { class: "check" }, r, h("span", {}, h("b", {}, label), desc ? h("div", { class: "small muted" }, desc) : null));
  };
  const find = h("button", { class: "btn" }, "Find Zebra printer");
  find.onclick = busy(find, async () => {
    status.replaceChildren(h("span", { class: "muted" }, "Looking…"));
    try {
      const d = await zebraPrinter();
      status.replaceChildren(h("span", { class: "badge good" }, `Found ${d.name || "printer"}`));
    } catch (e) {
      status.replaceChildren(h("span", { class: "badge bad", style: { height: "auto", whiteSpace: "normal", padding: "3px 9px" } }, e.message));
    }
  });
  const test = h("button", { class: "btn" }, "Print test label");
  test.onclick = busy(test, async () => {
    try {
      const d = await testZebra();
      status.replaceChildren(h("span", { class: "badge good" }, `Sent a test label to ${d.name || "the printer"}`));
    } catch (e) {
      status.replaceChildren(h("span", { class: "badge bad", style: { height: "auto", whiteSpace: "normal", padding: "3px 9px" } }, e.message));
    }
  });
  return h("section", { class: "card", id: "printing" }, h("h2", {}, "Printing on this computer"),
    h("p", { class: "muted" }, "Saved in this browser only, so the packing computer and your laptop can print differently."),
    h("div", { class: "stack" },
      h("h3", { class: "section", style: { margin: 0 } }, "Shipping labels"),
      radio("labels", "zebra", "Zebra thermal printer", "Labels print straight to the Zebra with no dialog. Needs Zebra Browser Print (free) installed and running on this computer."),
      radio("labels", "browser", "Browser print dialog", "Opens a 4×6 label page — print it to any printer."),
      h("div", { class: "row" }, find, test, status),
      h("p", { class: "small muted", style: { margin: 0 } },
        "Setup: install Zebra Browser Print from ", h("a", { href: "https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html", target: "_blank", rel: "noopener" }, "zebra.com"),
        ", set your ZT220 as its default printer, then open ", h("a", { href: "https://localhost:9101/ssl_support", target: "_blank", rel: "noopener" }, "localhost:9101/ssl_support"), " once and accept it so this page can talk to it."),
      h("h3", { class: "section", style: { margin: "6px 0 0" } }, "Packing slips"),
      radio("slips", "4x6", "4×6", "Same stock as labels"),
      radio("slips", "letter", "Letter (8.5×11)", "Office printer")));
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
    h("div", { class: "team-list" }, agents.map((a) => {
      const rm = h("button", { class: "btn sm ghost danger" }, "Remove");
      rm.onclick = busy(rm, async () => {
        if (!confirm(`Remove ${a.name}? Their open tickets become unassigned.`)) return;
        await api(`/agents/${a.id}`, { method: "DELETE" });
        reload(inner);
      });
      const avail = h("input", { type: "checkbox", checked: a.available !== 0, disabled: !isAdmin && a.id !== state.me.id, title: "Available for automatic assignment" });
      avail.onchange = async () => {
        try { await api(`/agents/${a.id}`, { method: "PATCH", body: { available: avail.checked } }); toast(avail.checked ? `${a.name} gets new tickets` : `${a.name} is skipped by auto-assign`); }
        catch (e) { toast(e.message, true); avail.checked = !avail.checked; }
      };
      return h("div", { class: "team-row" },
        h("div", { class: "avatar" }, initials(a.name)),
        h("div", { class: "who" }, h("b", {}, a.name), h("span", { class: "muted small", title: a.email }, a.email)),
        h("span", { class: "badge" }, a.role),
        h("label", { class: "check small" }, avail, "Available"),
        isAdmin && a.id !== state.me.id ? rm : h("span", { class: "rm-spacer" }));
    })),
    isAdmin ? h("div", { class: "team-add" }, email, name, role, add) : null);
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
      backfillBox(s),
      h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: {
        signature: sig.value,
        mailRules: { blockedSenders: blocked.value.split("\n"), skipAutomated: skip.checked, archiveOnClose: archive.checked, importDays: Number(days.value) },
      } })))));
}

function customsCard(s) {
  const c = { ...s.customs };
  const f = (label, key, attrs = {}) => {
    const i = h("input", { class: "input", value: c[key] ?? "", ...attrs });
    i.oninput = () => (c[key] = i.value);
    return h("label", { class: "field" }, label, i);
  };
  const sel = (label, key, options) => {
    const el = h("select", { class: "input" }, options.map(([v, t]) => h("option", { value: v, selected: c[key] === v }, t)));
    el.onchange = () => (c[key] = el.value);
    return h("label", { class: "field" }, label, el);
  };
  return h("section", { class: "card", id: "customs" }, h("h2", {}, "International & customs"),
    h("p", { class: "muted" }, "Used to fill in the customs list for orders going abroad. Each product's description, HS code and country of origin are remembered once you've entered them on a label, and HS codes set on products in Shopify are used first."),
    h("div", { class: "stack" },
      h("div", { class: "grid2" },
        f("Customs signer (your name)", "signer", { placeholder: "Tim Eads" }),
        f("Default item description", "description", { maxlength: 35 })),
      h("div", { class: "grid3" },
        f("Default HS code", "hsCode", { inputmode: "numeric", placeholder: "Optional", maxlength: 10 }),
        f("Default country of origin", "origin", { maxlength: 2 }),
        sel("Contents", "contents", [["merchandise", "Merchandise (sold)"], ["gift", "Gift"], ["sample", "Sample"], ["returned_goods", "Returned goods"], ["other", "Other"]])),
      h("div", { class: "grid2" },
        sel("Duties & taxes paid by", "dutiesPaidBy", [["recipient", "Customer (on delivery)"], ["sender", "Us (UPS bills our account)"]]),
        sel("If a package can't be delivered", "nonDelivery", [["return", "Return to us"], ["abandon", "Abandon"]])),
      h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: { customs: c } })))));
}

function backfillBox(s) {
  const job = s.backfill;
  const box = h("div", { class: "notice", style: { display: "grid", gap: "8px" } });
  const range = h("select", { class: "input", style: { width: "auto" } },
    [[90, "3 months"], [180, "6 months"], [365, "1 year"], [730, "2 years"], [1825, "5 years"]].map(([v, l]) => h("option", { value: v, selected: v === 365 }, l)));
  const start = h("button", { class: "btn sm" }, "Import history");
  start.onclick = busy(start, async () => {
    if (!confirm(`Import email from the last ${range.selectedOptions[0].textContent}? Older conversations come in as closed tickets (no auto-replies, rules or assignment). It runs in the background, about 25 conversations a minute.`)) return;
    const r = await api("/mailbox/backfill", { method: "POST", body: { days: Number(range.value) } });
    draw(r.job);
  });
  const stop = h("button", { class: "btn sm ghost" }, "Stop");
  stop.onclick = busy(stop, async () => { await api("/mailbox/backfill/stop", { method: "POST" }); draw({ ...job, finishedAt: new Date().toISOString(), error: "Stopped" }); });
  const draw = (j) => {
    const running = j && !j.finishedAt;
    mount(box,
      h("b", {}, "Import older email"),
      h("span", { class: "small" }, "Brings past conversations (inbox and archived) in as closed tickets, so customer history, search and analytics cover them."),
      j ? h("span", { class: "small" }, running ? `Importing the last ${j.days} days… ${j.threads} conversations checked, ${j.created} tickets added so far.` : `Last import (${j.days} days): ${j.threads} conversations checked, ${j.created} tickets added${j.error ? ` · ${j.error}` : ""}.`) : null,
      running && j.error ? h("span", { class: "small", style: { color: "var(--brick)" } }, `Last batch failed: ${j.error} (it retries every minute)`) : null,
      h("div", { class: "row" }, running ? stop : [range, start]));
  };
  draw(job);
  return box;
}

function shipping(s, presets, inner) {
  const a = s.shipFrom || { name: "", company: "Tuft the World", phone: "", address1: "", address2: "", city: "", state: "", zip: "", country: "US" };
  const f = (label, key, attrs = {}) => {
    const i = h("input", { class: "input", value: a[key] ?? "", ...attrs });
    i.oninput = () => (a[key] = i.value);
    return h("label", { class: "field" }, label, i);
  };
  const tare = (lb) => (lb >= 1 ? `${+lb.toFixed(2)} lb` : `${Math.round(lb * 16 * 10) / 10} oz`);
  const presetRows = presets.map((p) => {
    const del = h("button", { class: "btn sm ghost danger" }, "Remove");
    del.onclick = busy(del, async () => {
      if (!confirm(`Remove “${p.name}”?`)) return;
      await api(`/shipping/presets/${p.id}`, { method: "DELETE" });
      reload(inner);
    });
    const def = p.is_default
      ? h("span", { class: "badge good" }, "Default")
      : h("button", { class: "btn sm ghost", title: "Pre-select this box on new labels" }, "Make default");
    if (!p.is_default) def.onclick = busy(def, async () => { await api(`/shipping/presets/${p.id}/default`, { method: "POST" }); reload(inner); });
    return h("tr", {},
      h("td", {}, h("b", {}, p.name)),
      h("td", { class: "muted" }, p.type === "envelope" ? "Envelope" : p.type === "soft" ? "Soft pack" : "Box"),
      h("td", { class: "muted", style: { whiteSpace: "nowrap" } }, `${p.length} × ${p.width} × ${p.height} in`),
      h("td", { class: "muted", style: { whiteSpace: "nowrap" } }, `${tare(p.weight)} empty`),
      h("td", { style: { textAlign: "right", whiteSpace: "nowrap" } }, def, del));
  });
  const np = { name: "", type: "box", length: "", width: "", height: "", weight: "" };
  const pi = (key, ph, type = "number") => { const i = h("input", { class: "input", placeholder: ph, type, step: "0.1" }); i.oninput = () => (np[key] = i.value); return i; };
  const typeSel = h("select", { class: "input" }, [["box", "Box"], ["envelope", "Envelope"], ["soft", "Soft pack"]].map(([v, t]) => h("option", { value: v }, t)));
  typeSel.onchange = () => (np.type = typeSel.value);
  const addPreset = h("button", { class: "btn" }, icon("plus"), "Add box");
  addPreset.onclick = busy(addPreset, async () => { await api("/shipping/presets", { method: "POST", body: np }); reload(inner); });
  return card("Shipping", "The return address printed on every UPS label, and the boxes you ship in.",
    h("div", { class: "stack" },
      h("div", { class: "grid2" }, f("Contact name", "name"), f("Company", "company")),
      h("div", { class: "grid2" }, f("Address", "address1"), f("Suite / unit", "address2")),
      h("div", { class: "grid4" }, f("City", "city"), f("State", "state", { maxlength: 2 }), f("ZIP", "zip"), f("Country", "country", { maxlength: 2 })),
      h("div", { class: "grid2" }, f("Phone (required by UPS)", "phone"), h("span")),
      h("div", {}, saveButton(() => api("/settings", { method: "PUT", body: { shipFrom: a } }), "Save address")),
      h("h3", { class: "section" }, `Box sizes (${presets.length})`),
      h("p", { class: "muted small", style: { margin: 0 } }, "In “multi layer” names, the number in parentheses is the depth the box is cut down to."),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" }, h("tbody", {}, presetRows))),
      h("div", { class: "preset-add" },
        pi("name", "Box name", "text"), typeSel, pi("length", "L in"), pi("width", "W in"), pi("height", "H in"), pi("weight", "Empty lb"), addPreset)));
}

const SERVICE_CHOICES = [["cheapest", "Cheapest rate"], ["fastest", "Fastest rate"], ["usps:GroundAdvantage", "USPS Ground Advantage"], ["usps:Priority", "USPS Priority Mail"], ["usps:Express", "USPS Priority Mail Express"], ["03", "UPS Ground"], ["12", "UPS 3 Day Select"], ["02", "UPS 2nd Day Air"], ["59", "UPS 2nd Day Air A.M."], ["13", "UPS Next Day Air Saver"], ["01", "UPS Next Day Air"], ["14", "UPS Next Day Air Early"], ["93", "UPS Ground Saver"]];

const OP_LABELS = { eq: "is", gt: "is more than", lt: "is less than", includes_any: "includes any of", excludes: "excludes", contains: "contains" };

function shippingRules(data, presets, inner) {
  const rules = data.rules.map((r) => ({ name: r.name, enabled: r.enabled, conditions: r.conditions.map((c) => ({ ...c })), actions: r.actions.map((a) => ({ ...a })) }));
  const listEl = h("div");
  const fieldKeys = Object.keys(data.fields);

  const condRow = (rule, c, i) => {
    const field = h("select", { class: "input" }, fieldKeys.map((k) => h("option", { value: k, selected: c.field === k }, data.fields[k].label)));
    const op = h("select", { class: "input" }, data.fields[c.field].ops.map((o) => h("option", { value: o, selected: c.op === o }, OP_LABELS[o])));
    const value = ["item_quantity", "order_total"].includes(c.field)
      ? h("input", { class: "input", value: c.value, placeholder: "Number", inputmode: "decimal" })
      : growInput({ value: c.value, placeholder: "Comma-separated" });
    field.onchange = () => { c.field = field.value; c.op = data.fields[c.field].ops[0]; draw(); };
    op.onchange = () => (c.op = op.value);
    value.oninput = () => (c.value = value.value);
    const rm = h("button", { class: "btn sm ghost icon-only", "aria-label": "Remove condition", onclick: () => { rule.conditions.splice(i, 1); draw(); } }, icon("x"));
    return h("div", { class: "rule-line" }, h("span", { class: "rule-word" }, i === 0 ? "If" : "and"), field, op, value, rm);
  };
  const actionRow = (rule, a, i) => {
    const type = h("select", { class: "input" },
      [["set_package", "Use box"], ["require_signature", "Require signature"], ["set_service", "Ship with"], ["place_hold", "Hold the order"]].map(([v, t]) => h("option", { value: v, selected: a.type === v }, t)));
    let value;
    if (a.type === "set_package") value = h("select", { class: "input" }, h("option", { value: "" }, "Choose a box…"), presets.map((p) => h("option", { value: p.name, selected: a.value === p.name }, p.name)));
    else if (a.type === "require_signature") value = h("select", { class: "input" }, [["standard", "Signature required"], ["adult", "Adult signature"]].map(([v, t]) => h("option", { value: v, selected: a.value === v }, t)));
    else if (a.type === "set_service") value = h("select", { class: "input" }, SERVICE_CHOICES.map(([v, t]) => h("option", { value: v, selected: a.value === v }, t)));
    else value = growInput({ value: a.value, placeholder: "Note shown on the hold (optional)" });
    type.onchange = () => { a.type = type.value; a.value = { require_signature: "standard", set_service: "cheapest" }[a.type] ?? ""; draw(); };
    value.onchange = () => (a.value = value.value);
    value.oninput = () => (a.value = value.value);
    const rm = h("button", { class: "btn sm ghost icon-only", "aria-label": "Remove action", onclick: () => { rule.actions.splice(i, 1); draw(); } }, icon("x"));
    return h("div", { class: "rule-line" }, h("span", { class: "rule-word" }, i === 0 ? "Then" : "and"), type, value, h("span"), rm);
  };

  const draw = () => mount(listEl, rules.map((r, idx) => {
    const name = h("input", { class: "input", value: r.name, placeholder: "Rule name", style: { fontWeight: 700 } });
    name.oninput = () => (r.name = name.value);
    const on = h("input", { type: "checkbox", checked: r.enabled });
    on.onchange = () => (r.enabled = on.checked);
    const move = (d) => { const j = idx + d; if (j < 0 || j >= rules.length) return; [rules[idx], rules[j]] = [rules[j], rules[idx]]; draw(); };
    return h("div", { class: "macro-row" },
      h("div", { class: "rule-head" }, name,
        h("label", { class: "check", style: { whiteSpace: "nowrap" } }, on, "On"),
        h("button", { class: "btn sm ghost", title: "Move up (earlier rules win)", onclick: () => move(-1), disabled: idx === 0 }, "↑"),
        h("button", { class: "btn sm ghost danger", onclick: () => { rules.splice(idx, 1); draw(); } }, "Delete")),
      r.conditions.map((c, i) => condRow(r, c, i)),
      h("div", {}, h("button", { class: "btn sm ghost", onclick: () => { r.conditions.push({ field: "product_names", op: "includes_any", value: "" }); draw(); } }, icon("plus"), "Condition")),
      r.actions.map((a, i) => actionRow(r, a, i)),
      h("div", {}, h("button", { class: "btn sm ghost", onclick: () => { r.actions.push({ type: "set_package", value: "" }); draw(); } }, icon("plus"), "Action")));
  }));
  draw();

  const add = h("button", { class: "btn" }, icon("plus"), "New rule");
  add.onclick = () => {
    rules.push({ name: "", enabled: true, conditions: [{ field: "product_names", op: "includes_any", value: "" }], actions: [{ type: "set_package", value: "" }] });
    draw();
  };
  const learning = { parcel: true, weight: true, ...(data.learning ?? {}) };
  const learnBox = (key, label) => {
    const c = h("input", { type: "checkbox", checked: learning[key] });
    c.onchange = () => (learning[key] = c.checked);
    return h("label", { class: "check" }, c, label);
  };
  const save = saveButton(async () => {
    await api("/shipping/rules", { method: "PUT", body: { rules, learning } });
    reload(inner);
  }, "Save rules");
  return card("Shipping rules", "Applied to every order in the queue: they pick the box, signature and service, or hold the order. You can still change anything per order. Earlier rules win.",
    listEl, h("div", { class: "row", style: { marginTop: "8px" } }, save, add),
    h("h3", { class: "section" }, "Packing memory"),
    h("p", { class: "muted small", style: { margin: "0 0 8px" } }, "Every label you buy teaches the app how those items were packed: the box (or boxes, and what went in each) and the weight. The next order with the same items is packed the same way; the same products in other quantities reuse the box. Rules above still win."),
    h("div", { class: "stack" }, learnBox("parcel", "Remember boxes"), learnBox("weight", "Remember weights")),
    learnedList());
}

function learnedList() {
  const el = h("div", { class: "learned" }, h("p", { class: "small muted" }, "Loading what's been learned…"));
  const load = async () => {
    let learned;
    try { ({ learned } = await api("/shipping/learned")); } catch (e) { return mount(el, h("p", { class: "small", style: { color: "var(--brick)" } }, e.message)); }
    if (!learned.length) return mount(el, h("p", { class: "small muted" }, "Nothing learned yet — it starts with the next label you buy."));
    const search = h("input", { class: "input", type: "search", placeholder: `Search ${learned.length} remembered packings…`, "aria-label": "Search remembered packings" });
    const list = h("div");
    const draw = () => {
      const q = search.value.toLowerCase();
      mount(list, learned.filter((r) => r.label.toLowerCase().includes(q)).slice(0, 100).map((r) => {
        const forget = h("button", { class: "btn sm ghost danger" }, "Forget");
        forget.onclick = busy(forget, async () => {
          await api(`/shipping/learned?key=${encodeURIComponent(r.key)}`, { method: "DELETE" });
          learned = learned.filter((x) => x !== r);
          toast("Forgotten — the next order with these items starts fresh");
          draw();
        });
        return h("div", { class: "learned-row" },
          h("div", { class: "what" }, h("b", {}, r.label), h("div", { class: "small muted" }, `Used ${r.uses}× · last ${((t) => (t === "now" ? "just now" : /[mhd]$/.test(t) ? `${t} ago` : `on ${t}`))(relTime(r.updatedAt))}`)),
          h("div", { class: "boxes small" }, r.boxes.map((b, i) => h("div", {}, r.boxes.length > 1 ? h("span", { class: "muted" }, `Box ${i + 1}: `) : null, b.name, b.weight ? h("span", { class: "muted" }, ` · ${b.weight} lb`) : null))),
          forget);
      }));
    };
    search.oninput = draw;
    draw();
    mount(el, learned.length > 5 ? search : null, list);
  };
  load();
  return el;
}
