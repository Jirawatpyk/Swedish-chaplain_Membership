/**
 * `Sha256Hex` — branded canonical lowercase SHA-256 hex digest.
 *
 * Used by F8 audit payloads (`renewal_reminder_send_failed_permanent`)
 * for `recipient_email_hashed` so a future emit-site cannot accidentally
 * pass a plaintext email — the type system enforces the redaction policy
 * from CLAUDE.md "Forbidden in logs".
 *
 * Canonical form: 64 lowercase hex characters, optionally prefixed
 * `sha256:`. Validation lowercases input before storage so equality
 * comparisons across emit sites are stable.
 *
 * Pure value-object — no framework imports (Constitution Principle III).
 */
import { ok, err, type Result } from '@/lib/result';

declare const Sha256HexBrand: unique symbol;
export type Sha256Hex = string & { readonly [Sha256HexBrand]: true };

const RE_SHA256_HEX = /^(sha256:)?[0-9a-f]{64}$/;

export type Sha256HexError = {
  readonly kind: 'invalid_sha256_hex';
  readonly raw: string;
};

/**
 * Unchecked cast — for trusted callers (test fixtures + already-validated
 * sources). Production code paths handling untrusted input MUST use
 * `parseSha256Hex` instead.
 */
export function asSha256Hex(raw: string): Sha256Hex {
  return raw as Sha256Hex;
}

/**
 * Validates SHA-256 hex format. Lowercases input before regex check so
 * uppercase + mixed-case inputs are normalised to canonical form.
 *
 * TODO(F8-Phase4): Phase 4's `renewal_reminder_send_failed_permanent`
 * emit site MUST hash the recipient email through this validator
 * (NOT `asSha256Hex`) so the audit log never carries a plaintext or
 * malformed digest. The `recipient_email_hashed` payload field is
 * branded `Sha256Hex` to enforce this at the type level — the only
 * way to construct the brand from raw input is `parseSha256Hex`.
 */
export function parseSha256Hex(
  raw: string,
): Result<Sha256Hex, Sha256HexError> {
  if (typeof raw !== 'string') {
    return err({ kind: 'invalid_sha256_hex', raw: String(raw) });
  }
  const normalised = raw.toLowerCase();
  if (!RE_SHA256_HEX.test(normalised)) {
    return err({ kind: 'invalid_sha256_hex', raw });
  }
  return ok(normalised as Sha256Hex);
}
