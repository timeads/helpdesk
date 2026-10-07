// PDF shipping labels (Redo) as images: each page rendered with pdf.js, for the 4×6 print page and the Zebra.
import * as pdfjs from "/vendor/pdfjs/pdf.min.mjs";
import { contentBox } from "./zpl.js";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

/** Every page of a base64 PDF as a base64 PNG, at about `dpi` dots per inch. */
export async function pdfToPngs(base64, dpi = 300) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: view }).promise;
    // The label can sit on a bigger page (a 4×6 label on letter paper) or inside wide white margins:
    // crop to what's printed so it fills the 4×6 sticker instead of shrinking with the page
    // and stand a sideways label upright (a quarter turn clockwise), so it prints in proportion
    const c = upright(trimmed(canvas, Math.round(dpi * 0.06)));
    out.push({ png: c.toDataURL("image/png").split(",")[1], landscape: false });
  }
  return out;
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
function upright(canvas) {
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
