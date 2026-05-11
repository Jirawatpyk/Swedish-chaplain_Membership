/**
 * `Sha256Hex` — branded canonical lowercase SHA-256 hex digest.
 *
 * Used by F8 audit payloads (`renewal_reminder_send_failed_permanent`,
 * `tier_upgrade_pending_member_notified`) for `recipient_email_hashed`
 * so a future emit-site cannot accidentally pass a plaintext email —
 * the type system enforces the redaction policy from CLAUDE.md
 * "Forbidden in logs".
 *
 * Canonical form: 64 lowercase hex characters, optionally prefixed
 * `sha256:`. Validation lowercases input before storage so equality
 * comparisons across emit sites are stable.
 *
 * Pure value-object — Node `crypto` is allowed for hashing (used by
 * F1 + F4 + F5 in similar value-object positions).
 */
import { createHash } from 'node:crypto';
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
 * Used by the bounce-classification emit site (`renewal_reminder_send_
 * failed_permanent` path 1 — Resend webhook → bounce-class flag flip)
 * which is the only F8 audit payload that carries `recipient_email_hashed`.
 * That site MUST hash the recipient email through this validator
 * (NOT `asSha256Hex`) so the audit log never carries a plaintext or
 * malformed digest. The Sha256Hex brand on the payload field
 * enforces this at the type level — the only safe way to construct
 * the brand from raw input is `parseSha256Hex`.
 *
 * Note: F8 path-1 emit is not wired in the current dispatcher / retry
 * paths (which use paths 2+3 with `failure_kind` rather than
 * `bounce_class` + `recipient_email_hashed`); the validator stays in
 * place for the F1 webhook integration that will turn on this signal.
 */
/**
 * Hash a raw input string into a canonical lowercase SHA-256 hex
 * digest. Used by audit emit sites that capture an email-derived
 * forensic identifier without leaking plaintext into the audit log
 * (Constitution Principle I clause 4 + CLAUDE.md "Forbidden in logs").
 *
 * The caller is responsible for normalising the input (e.g.
 * `email.trim().toLowerCase()`) so different emit sites that hash the
 * same logical email produce equal digests.
 */
export function sha256HexOf(raw: string): Sha256Hex {
  return createHash('sha256').update(raw, 'utf8').digest('hex') as Sha256Hex;
}

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
