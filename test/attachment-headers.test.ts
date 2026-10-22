import { describe, expect, it } from "vitest";
import { attachmentHeaders } from "../src/lib/attachment-headers";

describe("attachmentHeaders", () => {
  it("sandboxes images and other files shown in the browser", () => {
    expect(attachmentHeaders({ filename: "box.jpg", mimeType: "image/jpeg" }, true)["content-security-policy"]).toBe("sandbox");
    expect(attachmentHeaders({ filename: "page.html", mimeType: "text/html" }, false)["content-security-policy"]).toBe("sandbox");
  });

  it("opens PDFs without the sandbox Chrome's PDF viewer refuses, but still loads nothing else", () => {
    const h = attachmentHeaders({ filename: "invoice.pdf", mimeType: "application/pdf" }, true);
    expect(h["content-security-policy"]).not.toContain("sandbox");
    expect(h["content-security-policy"]).toContain("default-src 'none'");
    expect(h["content-disposition"]).toBe("inline; filename*=UTF-8''invoice.pdf");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps the sandbox on a PDF that is downloaded rather than shown", () => {
    expect(attachmentHeaders({ filename: "a.pdf", mimeType: "application/pdf" }, false)["content-security-policy"]).toBe("sandbox");
  });

  it("encodes the filename", () => {
    expect(attachmentHeaders({ filename: "Rug photo #2.png", mimeType: "image/png" }, true)["content-disposition"])
      .toBe("inline; filename*=UTF-8''Rug%20photo%20%232.png");
  });
});
