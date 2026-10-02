// Settings → Packing slip: logo (converted to black & white for thermal printers), what's on the
// slip and in what order, with a live 4×6 preview.
import { api } from "./api.js";
import { h, mount, toast, busy, icon } from "./ui.js";
import { printSettings } from "./printing.js";

const SECTION_NAMES = {
  shipto: "Ship-to address",
  shipping: "Shipping method & box",
  items: "Items",
  note: "Order note",
  message: "Thank-you message",
  barcode: "Order barcode (for Scan & pack)",
};

/** Draws an image onto white, turns it pure black/white, trims the margins and returns a PNG data URL. */
async function toBlackWhite(src, threshold = 160, invert = false, maxWidth = 900) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("That file isn't an image this browser can read"));
    i.src = src;
  });
  const scale = Math.min(1, maxWidth / (img.naturalWidth || maxWidth));
  const w = Math.max(1, Math.round((img.naturalWidth || maxWidth) * scale));
  const hgt = Math.max(1, Math.round((img.naturalHeight || maxWidth / 3) * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hgt;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(img, 0, 0, w, hgt);
  const data = ctx.getImageData(0, 0, w, hgt);
  const px = data.data;
  let x0 = w, y0 = hgt, x1 = -1, y1 = -1;
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const black = invert ? lum >= threshold : lum < threshold;
      const v = black ? 0 : 255;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
      if (black) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) throw new Error("Nothing would print — try moving the darkness slider");
  ctx.putImageData(data, 0, 0);
  const pad = 2;
  const cw = Math.min(w, x1 - x0 + 1 + pad * 2);
  const ch = Math.min(hgt, y1 - y0 + 1 + pad * 2);
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, cw, ch);
  octx.drawImage(c, Math.max(0, x0 - pad), Math.max(0, y0 - pad), cw, ch, 0, 0, cw, ch);
  return out.toDataURL("image/png");
}

export function slipCard() {
  const el = h("section", { class: "card", id: "slip" }, h("h2", {}, "Packing slip"), h("p", { class: "muted" }, "Loading…"));
  api("/shipping/slip-layout").then(({ layout }) => draw(el, layout)).catch((e) => mount(el, h("h2", {}, "Packing slip"), h("div", { class: "notice bad" }, e.message)));
  return el;
}

function draw(el, saved) {
  const L = structuredClone(saved);
  const logo = { src: null, threshold: 160, invert: false }; // the original upload, kept so the slider can redo it
  let previewSize = printSettings().slips === "letter" ? "letter" : "4x6";

  // ---- Preview
  const frame = h("iframe", { class: "slip-frame", title: "Packing slip preview" });
  const frameWrap = h("div", { class: "slip-frame-wrap" }, frame);
  let pseq = 0;
  let ptimer;
  const preview = (delay = 250) => {
    clearTimeout(ptimer);
    ptimer = setTimeout(async () => {
      const my = ++pseq;
      try {
        const res = await fetch("/api/shipping/packing-slips/preview", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ layout: L, size: previewSize }),
        });
        const html = await res.text();
        if (my !== pseq) return;
        frame.srcdoc = html;
        frameWrap.classList.toggle("letter", previewSize === "letter");
      } catch (e) {
        toast(`Preview failed: ${e.message}`, true);
      }
    }, delay);
  };
  const changed = (delay) => { dirty.hidden = false; preview(delay); };

  // ---- Logo
  const logoImg = h("img", { alt: "Logo preview" });
  const logoBox = h("div", { class: "slip-logo" });
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/svg+xml,image/webp,image/gif", hidden: true });
  const slider = h("input", { type: "range", min: "40", max: "240", value: String(logo.threshold), "aria-label": "Darkness" });
  const invert = h("input", { type: "checkbox" });
  const convert = async () => {
    if (!logo.src) return;
    try {
      L.logo = await toBlackWhite(logo.src, logo.threshold, logo.invert);
      if (L.logo.length > 400_000) {
        L.logo = await toBlackWhite(logo.src, logo.threshold, logo.invert, 500);
        if (L.logo.length > 400_000) throw new Error("That logo is too detailed — try a simpler version");
      }
      drawLogo();
      changed(100);
    } catch (e) {
      toast(e.message, true);
    }
  };
  file.onchange = () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 8_000_000) return toast("That file is over 8 MB — use a smaller image", true);
    const r = new FileReader();
    r.onload = () => { logo.src = r.result; convert(); };
    r.readAsDataURL(f);
    file.value = "";
  };
  let st;
  slider.oninput = () => { logo.threshold = Number(slider.value); clearTimeout(st); st = setTimeout(convert, 120); };
  invert.onchange = () => { logo.invert = invert.checked; convert(); };
  const drawLogo = () => {
    if (L.logo) logoImg.src = L.logo;
    mount(logoBox,
      L.logo ? h("div", { class: "slip-logo-img" }, logoImg) : h("div", { class: "slip-logo-empty" }, icon("tag"), h("span", {}, "No logo yet")),
      h("div", { class: "stack", style: { gap: "8px", minWidth: 0 } },
        h("div", { class: "row", style: { gap: "6px" } },
          h("button", { class: "btn sm", onclick: () => file.click() }, icon("plus"), L.logo ? "Replace logo" : "Upload logo"),
          L.logo ? h("button", { class: "btn sm ghost", onclick: () => { L.logo = null; logo.src = null; drawLogo(); changed(0); } }, "Remove") : null),
        logo.src ? h("label", { class: "field" }, "Darkness — slide until the logo looks right", slider) : null,
        logo.src ? h("label", { class: "check" }, invert, "Invert (for a white logo on a dark background)") : null,
        h("span", { class: "small muted" }, L.logo && !logo.src
          ? "Saved in black & white. Upload again to adjust it."
          : "PNG, JPG or SVG. It's turned into pure black & white so thermal printers print it crisply; a logo on a transparent or white background works best.")),
      file);
  };
  drawLogo();

  // ---- Small controls
  const seg = (key, options) => {
    const wrap = h("div", { class: "seg" });
    const paint = () => mount(wrap, options.map(([v, t]) => h("button", { class: L[key] === v ? "on" : "", "aria-pressed": L[key] === v, onclick: () => { L[key] = v; paint(); changed(0); } }, t)));
    paint();
    return wrap;
  };
  const check = (key, label) => {
    const c = h("input", { type: "checkbox", checked: !!L[key] });
    c.onchange = () => { L[key] = c.checked; changed(0); };
    return h("label", { class: "check" }, c, label);
  };
  const text = (key, label, attrs = {}) => {
    const i = h(attrs.rows ? "textarea" : "input", { class: "input", ...attrs });
    i.value = L[key] ?? "";
    i.oninput = () => { L[key] = i.value; changed(400); };
    return h("label", { class: "field" }, label, i);
  };

  // ---- Sections (show/hide + order)
  const sectionsEl = h("div", { class: "slip-sections" });
  const drawSections = () => mount(sectionsEl, L.sections.map((s, i) => {
    const c = h("input", { type: "checkbox", checked: s.on, "aria-label": `Show ${SECTION_NAMES[s.id]}` });
    c.onchange = () => { s.on = c.checked; changed(0); };
    const move = (d) => { const j = i + d; [L.sections[i], L.sections[j]] = [L.sections[j], L.sections[i]]; drawSections(); changed(0); };
    return h("div", { class: "slip-section" + (s.on ? "" : " off") },
      h("label", { class: "check" }, c, SECTION_NAMES[s.id]),
      s.id === "items" ? h("span", { class: "small muted" }, "anything below sits at the bottom") : null,
      h("div", { class: "row", style: { gap: "2px", marginLeft: "auto" } },
        h("button", { class: "btn ghost sm icon-only", "aria-label": "Move up", disabled: i === 0, onclick: () => move(-1) }, icon("up")),
        h("button", { class: "btn ghost sm icon-only", "aria-label": "Move down", disabled: i === L.sections.length - 1, onclick: () => move(1) }, icon("down"))));
  }));
  drawSections();

  const dirty = h("span", { class: "small muted", hidden: true }, "Unsaved changes");
  const save = h("button", { class: "btn primary" }, "Save packing slip");
  save.onclick = busy(save, async () => {
    const r = await api("/shipping/slip-layout", { method: "PUT", body: { layout: L } });
    Object.assign(L, r.layout);
    dirty.hidden = true;
    toast("Packing slip saved — new slips use it right away");
  });
  const sizeSeg = h("div", { class: "seg" });
  const paintSize = () => mount(sizeSeg, [["4x6", "4×6"], ["letter", "Letter"]].map(([v, t]) =>
    h("button", { class: previewSize === v ? "on" : "", onclick: () => { previewSize = v; paintSize(); preview(0); } }, t)));
  paintSize();

  mount(el,
    h("h2", {}, "Packing slip"),
    h("p", { class: "muted" }, "Design the slip that goes in each box. Each computer prints the size picked under Printing (4×6 for a Zebra; choose the Zebra and 4×6 paper in the print dialog the first time)."),
    h("div", { class: "slip-designer" },
      h("div", { class: "stack", style: { gap: "18px", minWidth: 0 } },
        h("div", {}, h("h3", { class: "section", style: { marginTop: 0 } }, "Logo"), logoBox),
        h("div", { class: "row", style: { gap: "12px 24px", alignItems: "flex-start" } },
          h("div", { class: "field" }, "Logo size", seg("logoSize", [["s", "Small"], ["m", "Medium"], ["l", "Large"]])),
          h("div", { class: "field" }, "Header", seg("align", [["left", "Logo left"], ["center", "Centered"]]))),
        h("div", { class: "stack", style: { gap: "8px" } },
          text("storeName", "Store name"),
          h("div", { class: "row", style: { gap: "6px 18px" } }, check("showStoreName", "Show store name"), check("showReturnAddress", "Show return address"))),
        h("div", {}, h("h3", { class: "section" }, "What's on the slip"), sectionsEl),
        h("div", {}, h("h3", { class: "section" }, "Each item shows"),
          h("div", { class: "row", style: { gap: "6px 18px" } },
            check("showSku", "SKU"), check("showItemBarcode", "Product barcode"), check("itemImages", "Product photo (grayscale)"), check("showPrices", "Price"))),
        h("div", { class: "field" }, "Text size", seg("fontSize", [["s", "Compact"], ["m", "Normal"], ["l", "Large"]])),
        text("message", "Thank-you message", { rows: 2, maxlength: 300 }),
        text("footer", "Footer (website, social, returns info)", { maxlength: 120, placeholder: "tufttheworld.com · @tufttheworld" }),
        h("div", { class: "row" }, save, dirty)),
      h("div", { class: "slip-preview" },
        h("div", { class: "row", style: { justifyContent: "space-between", marginBottom: "8px" } }, h("b", {}, "Preview"), sizeSeg),
        frameWrap,
        h("span", { class: "small muted" }, "Sample order. Black & white, as a thermal printer prints it."))));
  preview(0);
}
