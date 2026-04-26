/**
 * Shared crypto primitives used across modules.
 *
 * Module-specific crypto (e.g. email-change token generation) lives in
 * the module's own application helpers. This file carries only the
 * universal primitives that multiple modules + route handlers share.
 */
import { createHash } from 'node:crypto';

/** SHA-256 of an arbitrary string as a lowercase hex digest. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 16-char SHA-256 prefix for log correlation. Use for any user/session
 * id that ends up in pino logs (CLAUDE.md "Hash user IDs in logs where
 * cross-request correlation is needed").
 *
 * Trade-off: the truncated form keeps log lines compact while preserving
 * enough entropy for cross-request correlation within a tenant. It is
 * NOT true anonymization — an operator with a roster of all user ids
 * can pre-compute the same hashes and reverse-lookup. For correlation
 * use cases (the reason this helper exists), that is acceptable; for
 * stronger anonymization a future caller should switch to HMAC-SHA256
 * with a server-side secret. Documented per /speckit.review R3 S5.
 */
export function hashIdForLog(value: string): string {
  return sha256Hex(value).slice(0, 16);
}
