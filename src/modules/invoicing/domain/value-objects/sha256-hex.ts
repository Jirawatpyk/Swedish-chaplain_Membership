/**
 * Sha256Hex — branded type for 64-char lowercase-hex SHA-256 digests.
 *
 * Used on every F4 surface that stores or compares PDF content hashes
 * (pdf_sha256 on invoices + credit_notes, receipt_pdf_sha256 on
 * payment UPDATEs, audit payloads). The brand prevents mixing a raw
 * `string` that happens to be a hex digest with arbitrary strings —
 * e.g., a caller cannot accidentally pass a base64 digest or a
 * Uint8Array.toString() result.
 *
 * Construct via `asSha256Hex(raw)` (validated — throws on bad input)
 * or `Sha256Hex.parse(raw)` (Result-returning for boundary code).
 *
 * Pure TypeScript — no framework imports (Principle III).
 */

const RE_SHA256 = /^[0-9a-f]{64}$/;

declare const Sha256HexBrand: unique symbol;
export type Sha256Hex = string & { readonly [Sha256HexBrand]: true };

export type Sha256HexError = { kind: 'malformed'; raw: string };

/**
 * Validate + brand a raw string. Throws on malformed input — use only
 * on trusted producer paths (e.g., the hash returned by `createHash`
 * inside the PDF adapter, which always produces a 64-char lowercase
 * hex string by construction).
 */
export function asSha256Hex(raw: string): Sha256Hex {
  if (!RE_SHA256.test(raw)) {
    throw new Error(`asSha256Hex: expected 64-char lowercase hex, got '${raw.slice(0, 16)}…'`);
  }
  return raw as Sha256Hex;
}

/**
 * Validate + brand without throwing. Returns a Result so callers at
 * system boundaries (DB reads, external inputs) can handle malformed
 * values explicitly.
 */
export const Sha256Hex = {
  parse(
    raw: string,
  ): { ok: true; value: Sha256Hex } | { ok: false; error: Sha256HexError } {
    if (!RE_SHA256.test(raw)) {
      return { ok: false, error: { kind: 'malformed', raw } };
    }
    return { ok: true, value: raw as Sha256Hex };
  },
} as const;
