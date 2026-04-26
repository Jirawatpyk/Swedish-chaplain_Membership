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

// Note: log-correlation user-id hashing lives in `src/lib/log-id.ts`
// (`hashId()`) — NOT here. That helper uses djb2 (fast, non-crypto) and
// is the canonical primitive for pino log fields per CLAUDE.md. Do not
// re-introduce a SHA-256 variant for the same purpose; it duplicates
// the established helper and was rolled back per /simplify R3 review.
