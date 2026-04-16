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
