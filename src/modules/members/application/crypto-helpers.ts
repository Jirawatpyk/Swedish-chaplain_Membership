/**
 * Shared crypto helpers for email-change token generation.
 * Used by change-contact-email and resend-verification-email use cases.
 */
import { createHash, randomBytes } from 'node:crypto';

/** FR-012a activation delay — 5 min window before verification token can be consumed. */
export const VERIFICATION_ACTIVATION_DELAY_MS = 5 * 60 * 1000;
/** Verification token TTL — 24 hours. */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Revert token TTL — 48 hours. */
export const REVERT_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;

/** Generate a crypto-safe token pair (plaintext for email link, sha256 hash for DB storage). */
export function generateToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

/** Hash an email for audit log storage (PDPA/GDPR data minimisation). */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}
