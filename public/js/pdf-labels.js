// PDF shipping labels (Redo) as images: each page rendered with pdf.js, for the 4×6 print page and the Zebra.
import * as pdfjs from "/vendor/pdfjs/pdf.min.mjs";

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
    out.push({ png: canvas.toDataURL("image/png").split(",")[1], landscape: canvas.width > canvas.height });
  }
  return out;
}
