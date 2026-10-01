// Pure helpers for reading Gmail API message payloads and building outgoing MIME.
import { base64UrlDecode, base64UrlEncode } from "./util";

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function headerMap(part: GmailPart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of part.headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

export function extractContent(payload: GmailPart): { text: string; html: string | null; attachments: AttachmentMeta[] } {
  let text = "";
  let html: string | null = null;
  const attachments: AttachmentMeta[] = [];

  const walk = (part: GmailPart) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const disposition = (headerMap(part)["content-disposition"] ?? "").toLowerCase();
    const isAttachment = !!part.filename && (!!part.body?.attachmentId || disposition.startsWith("attachment"));
    if (isAttachment && part.body?.attachmentId) {
      attachments.push({
        id: part.body.attachmentId,
        filename: part.filename!,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
      return;
    }
    if (part.parts?.length) {
      part.parts.forEach(walk);
      return;
    }
    const data = part.body?.data;
    if (!data) return;
    if (mime === "text/plain" && !text) text = base64UrlDecode(data);
    else if (mime === "text/html" && html === null) html = base64UrlDecode(data);
  };
  walk(payload);

  if (!text && html) text = htmlToText(html);
  return { text, html, attachments };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Mailing lists, marketing and auto-replies — not customer conversations. */
export function isAutomated(headers: Record<string, string>): boolean {
  const precedence = (headers["precedence"] ?? "").toLowerCase();
  if (["bulk", "list", "junk"].includes(precedence)) return true;
  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers["list-unsubscribe"] || headers["list-id"]) return true;
  const from = (headers["from"] ?? "").toLowerCase();
  if (/mailer-daemon|postmaster@/.test(from)) return true;
  return false;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  const escaped = escapeHtml(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1">$1</a>');
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">' +
    escaped
      .split(/\n{2,}/)
      .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
      .join("") +
    "</div>"
  );
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII header values
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  const safe = name.replace(/["\\\r\n]/g, "");
  return /^[\x20-\x7e]*$/.test(safe) ? `"${safe}" <${email}>` : `${encodeHeader(safe)} <${email}>`;
}

function wrapBase64(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  base64: string; // standard base64
}

export interface OutgoingMessage {
  fromEmail: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  inReplyTo?: string | null;
  references?: string | null;
  text: string;
  html?: string;
  attachments?: OutgoingAttachment[];
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

export function buildMime(msg: OutgoingMessage, boundarySeed = crypto.randomUUID().replace(/-/g, "")): string {
  const alt = `alt_${boundarySeed}`;
  const mixed = `mix_${boundarySeed}`;
  const html = msg.html ?? textToHtml(msg.text);
  const headers = [
    `From: ${formatAddress(msg.fromEmail, msg.fromName)}`,
    `To: ${msg.to.join(", ")}`,
    ...(msg.cc?.length ? [`Cc: ${msg.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    ...(msg.inReplyTo ? [`In-Reply-To: ${msg.inReplyTo}`] : []),
    ...(msg.references || msg.inReplyTo ? [`References: ${(msg.references ?? msg.inReplyTo)!}`] : []),
    "MIME-Version: 1.0",
  ];
  const altBody = [
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(utf8Base64(msg.text)),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(utf8Base64(html)),
    `--${alt}--`,
  ].join("\r\n");

  if (!msg.attachments?.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altBody, ""].join("\r\n");
  }
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", altBody];
  for (const a of msg.attachments) {
    const name = a.filename.replace(/["\r\n]/g, "");
    parts.push(
      `--${mixed}`,
      `Content-Type: ${a.mimeType}; name="${encodeHeader(name)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(a.base64.replace(/\s+/g, "")),
    );
  }
  parts.push(`--${mixed}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", parts.join("\r\n"), ""].join("\r\n");
}

export function encodeRaw(mime: string): string {
  return base64UrlEncode(mime);
}
