import { describe, expect, it } from "vitest";
import { buildMime, extractContent, isAutomated, replySubject, textToHtml } from "../src/lib/mime";
import { base64UrlEncode, parseAddress, splitAddressList } from "../src/lib/util";

const b64 = (s: string) => base64UrlEncode(s);

describe("extractContent", () => {
  it("reads nested multipart with attachments", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64("Hi — where’s my rug?") } },
            { mimeType: "text/html", body: { data: b64("<p>Hi — where’s my rug?</p>") } },
          ],
        },
        { mimeType: "image/jpeg", filename: "box.jpg", body: { attachmentId: "att1", size: 2048 } },
      ],
    };
    const r = extractContent(payload);
    expect(r.text).toBe("Hi — where’s my rug?");
    expect(r.html).toBe("<p>Hi — where’s my rug?</p>");
    expect(r.attachments).toEqual([{ id: "att1", filename: "box.jpg", mimeType: "image/jpeg", size: 2048 }]);
  });

  it("derives text from html-only mail", () => {
    const r = extractContent({ mimeType: "text/html", body: { data: b64("<div>Line one<br>Line &amp; two</div>") } });
    expect(r.text).toBe("Line one\nLine & two");
  });
});

describe("isAutomated", () => {
  it("flags newsletters and auto-replies but not people", () => {
    expect(isAutomated({ "list-unsubscribe": "<mailto:x>" })).toBe(true);
    expect(isAutomated({ precedence: "bulk" })).toBe(true);
    expect(isAutomated({ "auto-submitted": "auto-replied" })).toBe(true);
    expect(isAutomated({ "auto-submitted": "no", from: "Jane <jane@example.com>" })).toBe(false);
  });
});

describe("addresses", () => {
  it("parses display names", () => {
    expect(parseAddress('"Doe, Jane" <Jane@Example.com>')).toEqual({ name: "Doe, Jane", email: "jane@example.com" });
    expect(parseAddress("bob@example.com")).toEqual({ name: null, email: "bob@example.com" });
  });
  it("splits lists without breaking quoted commas", () => {
    expect(splitAddressList('"Doe, Jane" <j@x.com>, b@x.com')).toEqual(['"Doe, Jane" <j@x.com>', "b@x.com"]);
  });
});

describe("buildMime", () => {
  it("threads replies and encodes unicode", () => {
    const mime = buildMime(
      {
        fromEmail: "support@tufttheworld.com",
        fromName: "Tuft the World Support",
        to: ["jane@example.com"],
        subject: replySubject("Rug order ✨"),
        inReplyTo: "<abc@mail.gmail.com>",
        references: "<root@x> <abc@mail.gmail.com>",
        text: "Thanks — shipping today!",
      },
      "seed",
    );
    expect(mime).toContain('From: "Tuft the World Support" <support@tufttheworld.com>');
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(mime).toContain("References: <root@x> <abc@mail.gmail.com>");
    expect(mime).toContain('multipart/alternative; boundary="alt_seed"');
    const textPart = mime.split("\r\n\r\n")[2].split("\r\n--")[0];
    expect(new TextDecoder().decode(Uint8Array.from(atob(textPart.replace(/\r\n/g, "")), (c) => c.charCodeAt(0)))).toBe(
      "Thanks — shipping today!",
    );
  });

  it("adds attachments as multipart/mixed", () => {
    const mime = buildMime(
      { fromEmail: "s@x.com", to: ["a@x.com"], subject: "Label", text: "Attached", attachments: [{ filename: "label.pdf", mimeType: "application/pdf", base64: "JVBERi0=" }] },
      "seed",
    );
    expect(mime).toContain('multipart/mixed; boundary="mix_seed"');
    expect(mime).toContain('Content-Disposition: attachment; filename="label.pdf"');
  });

  it("does not double up Re:", () => {
    expect(replySubject("RE: hello")).toBe("RE: hello");
    expect(replySubject("hello")).toBe("Re: hello");
  });
});

describe("textToHtml", () => {
  it("escapes markup and links urls", () => {
    const html = textToHtml("<b>hi</b>\nsee https://ups.com/track?x=1.");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;<br>");
    expect(html).toContain('<a href="https://ups.com/track?x=1">https://ups.com/track?x=1</a>.');
  });
});
