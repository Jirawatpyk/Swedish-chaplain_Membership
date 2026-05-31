/**
 * F9 US5/US6 — private export-artefact download token (research R6).
 *
 * The download proxy (`/api/internal/exports/[jobId]/download`) protects a
 * private Blob artefact (E-Book / GDPR archive) with defence-in-depth: a valid
 * session + RBAC (subject member or same-tenant admin) AND a short-lived,
 * single-use, job-bound token.
 *
 * The token (the random secret given to the client) is NEVER stored. Only its
 * keyed HMAC (`EXPORT_DOWNLOAD_TOKEN_SECRET`, ≥32 bytes, distinct from
 * auth/unsubscribe secrets) is persisted in `export_jobs.download_token_hash`,
 * bound to the `jobId` so a token minted for one job can never authorise
 * another. Single-use: the hash is nulled on first successful download; expiry
 * is enforced via `export_jobs.expires_at`. A DB-only leak of the hash cannot be
 * reversed to a token (HMAC + secret); a token-only leak is bounded by the
 * single-use + TTL window.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

function downloadTokenSecret(): string {
  const secret = env.insights.exportDownloadTokenSecret;
  if (secret === null) {
    // The F9 export routes are flag-gated (FEATURE_F9_DASHBOARD); the env
    // cross-field check guarantees the secret is present when the flag is on.
    // Reaching here means a misconfiguration — fail loud rather than mint a
    // forgeable token.
    throw new Error(
      'EXPORT_DOWNLOAD_TOKEN_SECRET is not configured — F9 export download requires it',
    );
  }
  return secret;
}

/** Mint a fresh opaque download token (the client-side secret). */
export function mintDownloadToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Keyed, job-bound HMAC stored in `export_jobs.download_token_hash`. */
export function hashDownloadToken(jobId: string, token: string): string {
  return createHmac('sha256', downloadTokenSecret())
    .update(`${jobId}.${token}`)
    .digest('hex');
}

/**
 * Constant-time verification of a presented token against the stored hash for
 * `jobId`. Returns false on any mismatch (wrong token, wrong job, tampered
 * hash) without a timing channel.
 */
export function verifyDownloadToken(
  jobId: string,
  token: string,
  storedHash: string,
): boolean {
  // Both sides are SHA-256 HMAC hex strings (`digest('hex')`). Decode as hex so
  // the constant-time compare runs over the 32 raw digest bytes, not the 64 hex
  // text bytes — semantically correct and robust if the digest encoding changes.
  // A malformed (non-hex) storedHash decodes to a different length and is caught
  // by the length guard below before timingSafeEqual (which throws on mismatch).
  const computed = Buffer.from(hashDownloadToken(jobId, token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (computed.length !== stored.length || computed.length === 0) return false;
  return timingSafeEqual(computed, stored);
}
