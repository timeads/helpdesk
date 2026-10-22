/**
 * Response headers for serving a customer's attachment from our own origin.
 *
 * Files people send us are untrusted, so anything shown in the browser gets `CSP: sandbox` (no
 * scripts, its own origin) — except PDFs. Chrome refuses to open its PDF viewer inside a sandboxed
 * document and shows "help.tuftlife.com is blocked … ERR_BLOCKED_BY_CLIENT" instead. A PDF opens in
 * the browser's own viewer, which never runs it as a page of ours, so it goes without the sandbox
 * but keeps a CSP that allows nothing else to load.
 */
export function attachmentHeaders(meta: { filename: string; mimeType: string }, inline: boolean): Record<string, string> {
  const pdf = /^application\/pdf\b/i.test(meta.mimeType);
  return {
    "content-type": meta.mimeType,
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-security-policy": pdf && inline ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'" : "sandbox",
    "accept-ranges": "bytes",
  };
}
