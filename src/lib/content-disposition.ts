/**
 * Content-Disposition helper (F4 Phase 10g T121).
 *
 * Formats an RFC 6266-compliant `Content-Disposition: attachment`
 * header for binary downloads (PDF streams). Produces BOTH the ASCII
 * fallback (`filename=...`) and the UTF-8 extended form
 * (`filename*=UTF-8''...`) so non-ASCII tenant brand names in
 * document filenames render correctly across browsers.
 *
 * Defense-in-depth layers applied to `raw` before it lands in the
 * header:
 *
 *   1. Strip CR (0x0D) + LF (0x0A). `Content-Disposition` is a single
 *      header line — any raw CR/LF in the filename would let an
 *      attacker-controlled document_number split the header and
 *      forge additional response headers (header injection / CRLF
 *      injection). The other two steps already cover this via the
 *      printable-ASCII whitelist, but calling it out explicitly makes
 *      the intent survive future regex refactors.
 *
 *   2. Strip `"` and `\` — both have special meaning inside a
 *      `filename="..."` quoted-string and must not leak as-is.
 *
 *   3. Strip every non-printable and non-ASCII byte (`[^\x20-\x7E]`).
 *      The UTF-8 form (`filename*=UTF-8''...`) carries the correct
 *      original bytes percent-encoded; the ASCII fallback exists
 *      only for legacy clients that don't parse RFC 5987.
 *
 * Currently `document_number` is produced by `DocumentNumber` which
 * enforces `{prefix}-{YYYY}-{NNNNNN}` — digits + hyphens + ASCII
 * prefix only. The CRLF strip is therefore defense-in-depth against
 * FUTURE format changes (e.g. if a tenant adds a brand suffix or a
 * localised prefix containing whitespace).
 */

function asciiSafe(raw: string): string {
  return raw
    .replace(/[\r\n]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_');
}

/**
 * Build an RFC 6266 `Content-Disposition: attachment` header value.
 *
 * Example:
 *   buildAttachmentContentDisposition('INV-2026-000001.pdf')
 *   → `attachment; filename="INV-2026-000001.pdf"; filename*=UTF-8''INV-2026-000001.pdf`
 *
 *   buildAttachmentContentDisposition('ใบแจ้งหนี้.pdf')
 *   → `attachment; filename="________.pdf"; filename*=UTF-8''%E0%B9%83%E0%B8%9A%E0%B9%81%E0%B8%88%E0%B9%89%E0%B8%87%E0%B8%AB%E0%B8%99%E0%B8%B5%E0%B9%89.pdf`
 */
export function buildAttachmentContentDisposition(raw: string): string {
  const safe = asciiSafe(raw);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/**
 * Exported for unit tests — call-site code should use
 * `buildAttachmentContentDisposition` instead.
 */
export const _asciiSafeForTest = asciiSafe;
