// Turns packing slip HTML into ZPL for the Zebra: the slip is drawn exactly as designed
// (via an SVG <foreignObject>), made black & white (photos dithered), split into 4×6 pages
// between rows, and each page sent as one compressed ^GFA graphic.

/** ZPL's ASCII compression for one row of hex: runs → count letters, trailing zeros → ",". */
export function compressRow(hex, prev) {
  if (prev !== null && hex === prev) return ":";
  const trimmed = hex.replace(/0+$/, "");
  let out = "";
  for (let i = 0; i < trimmed.length;) {
    const ch = trimmed[i];
    let n = 1;
    while (trimmed[i + n] === ch) n++;
    i += n;
    out += runCode(n) + ch;
  }
  return trimmed.length < hex.length ? out + "," : out;
}

function runCode(n) {
  if (n === 1) return "";
  let code = "";
  while (n > 400) { code += "z"; n -= 400; }
  if (n >= 20) { code += String.fromCharCode("g".charCodeAt(0) + Math.floor(n / 20) - 1); n %= 20; }
  if (n > 0) code += String.fromCharCode("G".charCodeAt(0) + n - 1);
  return code;
}

/** Inverse of compressRow (used by the tests to check the encoding round-trips). */
export function expandRows(data, bytesPerRow) {
  const width = bytesPerRow * 2;
  const rows = [];
  let row = "";
  let count = 0;
  const flush = () => { rows.push(row.padEnd(width, "0").slice(0, width)); row = ""; };
  for (const ch of data) {
    if (ch === ":") { if (row) flush(); rows.push(rows[rows.length - 1]); continue; }
    if (ch === ",") { flush(); continue; }
    if (ch === "!") { rows.push(row.padEnd(width, "F")); row = ""; continue; }
    if (ch >= "G" && ch <= "Y") { count += ch.charCodeAt(0) - 70; continue; }
    if (ch >= "g" && ch <= "z") { count += (ch.charCodeAt(0) - 102) * 20; continue; }
    row += ch.repeat(count || 1);
    count = 0;
    if (row.length >= width) flush();
  }
  if (row) flush();
  return rows;
}

/** 1-bit pixels (1 = black) → a ZPL ^GFA field at the top-left of the label. */
export function bitsToGfa(bits, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  let prev = null;
  const parts = [];
  for (let y = 0; y < height; y++) {
    let hex = "";
    for (let b = 0; b < bytesPerRow; b++) {
      let v = 0;
      for (let k = 0; k < 8; k++) {
        const x = b * 8 + k;
        if (x < width && bits[y * width + x]) v |= 0x80 >> k;
      }
      hex += v.toString(16).toUpperCase().padStart(2, "0");
    }
    parts.push(compressRow(hex, prev));
    prev = hex;
  }
  const total = bytesPerRow * height;
  return `^FO0,0^GFA,${total},${total},${bytesPerRow},${parts.join("")}^FS`;
}

/** CRC-16/XMODEM (poly 0x1021, init 0) over the Z64 text, as ZPL expects after ":Z64:…:". */
export function crc16(text) {
  let crc = 0;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * 1-bit pixels → ^GFA using Z64 (zlib + base64): several times smaller than the ASCII form,
 * which keeps Browser Print happy. Falls back to ASCII where the browser can't compress.
 */
export async function bitsToGfaZ64(bits, width, height) {
  if (typeof CompressionStream === "undefined") return bitsToGfa(bits, width, height);
  const bytesPerRow = Math.ceil(width / 8);
  const raw = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (bits[y * width + x]) raw[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  let bin = "";
  for (let i = 0; i < zipped.length; i += 0x8000) bin += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  return `^FO0,0^GFA,${raw.length},${raw.length},${bytesPerRow},:Z64:${b64}:${crc16(b64)}^FS`;
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("Couldn't draw the packing slip"));
  img.src = src;
});

/**
 * Draws one slip and returns ZPL for its pages (4×6 each).
 * @param {string} html  the slip's <section class="slip …"> markup
 * @param {string} css   the slip stylesheet
 * @param {number} dpi   printer resolution (203 for most Zebras, 300 for 300 dpi models)
 */
export async function slipToZpl(html, css, dpi = 203) {
  const cssWidth = 384; // 4in at 96 css px per inch
  const scale = dpi / 96;
  const W = Math.round(4 * dpi);
  const pageH = Math.round(6 * dpi);

  // 1. Lay it out off-screen to measure its height, where rows end, and where the photos are
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${cssWidth}px;pointer-events:none;`;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${css}</style><div class="slip-root">${html}</div>`;
  document.body.append(host);
  await Promise.all([...shadow.querySelectorAll("img")].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  const slip = shadow.querySelector(".slip");
  const top = slip.getBoundingClientRect().top;
  const H = Math.ceil(slip.getBoundingClientRect().height);
  const photos = [...slip.querySelectorAll("td.img img")].map((e) => {
    const r = e.getBoundingClientRect();
    return { x: Math.floor((r.left - slip.getBoundingClientRect().left) * scale), y: Math.floor((r.top - top) * scale), w: Math.ceil(r.width * scale), h: Math.ceil(r.height * scale) };
  });
  host.remove();

  // 2. Draw it: the slip inside an SVG foreignObject, rendered at the printer's resolution
  const doc = document.implementation.createHTMLDocument("");
  const root = doc.createElement("div");
  root.setAttribute("class", "slip-root");
  root.innerHTML = `<style>${css}</style>${html}`;
  const xhtml = new XMLSerializer().serializeToString(root);
  const fullH = Math.ceil(H * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${fullH}" viewBox="0 0 ${cssWidth} ${H}"><foreignObject x="0" y="0" width="${cssWidth}" height="${H}">${xhtml}</foreignObject></svg>`;
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = fullH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, fullH);
  ctx.drawImage(img, 0, 0, W, fullH);
  const px = ctx.getImageData(0, 0, W, fullH).data;

  // 3. Black & white: sharp threshold for text and lines, dithering inside product photos
  const lum = new Float32Array(W * fullH);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const bits = new Uint8Array(W * fullH);
  for (let i = 0; i < bits.length; i++) bits[i] = lum[i] < 150 ? 1 : 0;
  for (const p of photos) {
    for (let y = Math.max(0, p.y); y < Math.min(fullH, p.y + p.h); y++) {
      for (let x = Math.max(0, p.x); x < Math.min(W, p.x + p.w); x++) {
        const i = y * W + x;
        const old = lum[i];
        const v = old < 128 ? 0 : 255;
        bits[i] = v === 0 ? 1 : 0;
        const err = old - v;
        if (x + 1 < p.x + p.w) lum[i + 1] += (err * 7) / 16;
        if (y + 1 < p.y + p.h) {
          if (x > p.x) lum[i + W - 1] += (err * 3) / 16;
          lum[i + W] += (err * 5) / 16;
          if (x + 1 < p.x + p.w) lum[i + W + 1] += err / 16;
        }
      }
    }
  }

  // 4. Pages: break on a blank band of pixels near the bottom, so no line of text is cut in half
  const blank = new Uint8Array(fullH);
  for (let y = 0; y < fullH; y++) {
    let any = 0;
    for (let x = 0, i = y * W; x < W; x++, i++) if (bits[i]) { any = 1; break; }
    blank[y] = any ? 0 : 1;
  }
  const pages = [];
  const margin = Math.round(0.3 * dpi); // where a slip runs onto another label, keep text off the cut edges
  for (let y = 0; y < fullH;) {
    if (fullH - y < 8) break; // rounding leftovers
    const first = pages.length === 0;
    const top = first ? 0 : margin; // the slip's own padding covers the first label's top
    const room = pageH - top;
    let end = Math.min(fullH, y + room);
    if (end < fullH) {
      end = y + room - margin;
      const band = Math.max(3, Math.round(dpi / 50)); // ~0.5 mm of white
      for (let e = end; e > y + room * 0.4; e--) {
        let ok = true;
        for (let k = 0; k < band; k++) if (!blank[e - 1 - k]) { ok = false; break; }
        if (ok) { end = e - Math.floor(band / 2); break; }
      }
    }
    // skip blank rows at the top of a continuation so it starts right at the margin
    let from = y;
    if (!first) while (from < end && blank[from]) from++;
    if (from < end) pages.push(`^XA^PW${W}^LL${pageH}^LH0,0${(await bitsToGfaZ64(bits.subarray(from * W, end * W), W, end - from)).replace("^FO0,0", `^FO0,${top}`)}^XZ`);
    y = end;
  }
  return pages.join("\n");
}

/** A label image (UPS GIF is landscape, USPS PNG is portrait 4×6) as one 4×6 ZPL label. */
export async function imageToZpl(base64, format, dpi = 203) {
  const W = Math.round(4 * dpi);
  const H = Math.round(6 * dpi);
  const img = await loadImage(`data:image/${format === "PNG" ? "png" : "gif"};base64,${base64}`);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const landscape = img.naturalWidth > img.naturalHeight;
  if (landscape) {
    // turn it a quarter clockwise, as the browser label page does
    ctx.translate(W, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0, H, W);
  } else {
    const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    ctx.drawImage(img, (W - img.naturalWidth * k) / 2, (H - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
  }
  const px = ctx.getImageData(0, 0, W, H).data;
  const bits = new Uint8Array(W * H);
  for (let i = 0; i < bits.length; i++) bits[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2] < 128 ? 1 : 0;
  return `^XA^PW${W}^LL${H}^LH0,0${await bitsToGfaZ64(bits, W, H)}^XZ`;
}

/** Bounding box of the dark-enough pixels in RGBA data (null if there are none). */
export function contentBox(px, w, h, threshold = 200) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** The canvas cropped to its non-white content, plus `pad` pixels of white around it (unchanged if blank). */
export function trimmed(canvas, pad = 0) {
  const { width: w, height: h } = canvas;
  const px = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const box = contentBox(px, w, h);
  if (!box) return canvas;
  const x0 = Math.max(0, box.x0 - pad), y0 = Math.max(0, box.y0 - pad);
  const x1 = Math.min(w - 1, box.x1 + pad), y1 = Math.min(h - 1, box.y1 + pad);
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return canvas;
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** A landscape canvas turned a quarter clockwise to portrait; portrait ones as they are. */
export function upright(canvas) {
  if (canvas.width <= canvas.height) return canvas;
  const out = document.createElement("canvas");
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext("2d");
  ctx.translate(out.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** A label image (Redo PNG/GIF) cropped to what's printed and stood upright, as a PNG: it then fills the 4×6. */
export async function fitLabelImage(base64, format, padPx = 12) {
  const img = await loadImage(`data:image/${format === "GIF" ? "gif" : "png"};base64,${base64}`);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return upright(trimmed(canvas, padPx)).toDataURL("image/png").split(",")[1];
}
