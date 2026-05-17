/**
 * Crypto-based webhook signature verifier (F6 Infrastructure).
 *
 * Implements `WebhookSignatureVerifier` port per research.md R2:
 *   - HMAC-SHA256 over `${timestamp}.${rawBody}`
 *   - `crypto.timingSafeEqual` for the byte compare (no timing oracle)
 *   - Strip `sha256=` prefix; assert exact 64-char lowercase hex shape
 *   - Try/catch wrapped (E8) — `timingSafeEqual` THROWS on length mismatch
 *     in Node, which would surface as HTTP 500 (information leak) without
 *     the guard. With the guard, any input-shape error returns the same
 *     `signature_mismatch` outcome as a genuinely-wrong signature.
 *
 * Pure adapter — no DB, no logging. Stateless. The use-case
 * `verify-webhook-signature.ts` (T043) is the orchestration layer that
 * decides skew + active-vs-grace fallback; this adapter just answers
 * "does this signature match this body+timestamp+secret?".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  WebhookSignatureVerifier,
  VerifyInput,
  VerifyOutcome,
} from '../application/ports/webhook-signature-verifier';

const SIGNATURE_PREFIX = 'sha256=';
const HEX_LENGTH = 64; // 32 bytes hex-encoded
const HEX_PATTERN = /^[0-9a-f]+$/i;

/**
 * Compute the expected signature for a given timestamp + body + secret.
 * Returns the hex digest (no `sha256=` prefix).
 */
function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Produce the X-Chamber-Signature + X-Chamber-Timestamp headers for a
 * raw body using the tenant's active secret. Used by the Phase 5 T072
 * `runTestWebhook` use-case to sign synthetic test deliveries before
 * POSTing them to the tenant's own webhook URL. Mirror of what
 * Zapier's "Webhooks by Zapier" Crypto utility produces in production
 * (T044 verifier accepts both byte-for-byte).
 *
 * Pure — no I/O beyond `node:crypto` HMAC primitives. Stateless and
 * safe to share across concurrent requests.
 */
export function signWebhookRequest(input: {
  readonly secret: string;
  readonly rawBody: string;
  readonly now: Date;
}): { readonly signatureHeader: string; readonly timestamp: string } {
  const timestamp = Math.floor(input.now.getTime() / 1000).toString();
  const sig = computeSignature(input.secret, timestamp, input.rawBody);
  return {
    signatureHeader: `${SIGNATURE_PREFIX}${sig}`,
    timestamp,
  };
}

/**
 * Constant-time compare of two hex-encoded SHA-256 digests. Returns
 * FALSE on any input-shape error (wrong length, non-hex, missing
 * prefix). NEVER throws — E8 guard.
 */
function safeHexEqual(provided: string, expected: string): boolean {
  // Strip prefix
  const stripped = provided.startsWith(SIGNATURE_PREFIX)
    ? provided.slice(SIGNATURE_PREFIX.length)
    : provided;

  // Shape guards
  if (stripped.length !== HEX_LENGTH) return false;
  if (!HEX_PATTERN.test(stripped)) return false;
  if (expected.length !== HEX_LENGTH) return false;

  try {
    const a = Buffer.from(stripped.toLowerCase(), 'hex');
    const b = Buffer.from(expected.toLowerCase(), 'hex');
    if (a.length !== b.length) return false; // Belt-and-suspenders
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Pure verification core — given input, returns the outcome.
 * No I/O. Used by both the production use-case and the test fixtures.
 */
export function verifyOnce(input: VerifyInput): VerifyOutcome {
  // Stage 1: header presence checks.
  if (input.signatureHeader === null || input.signatureHeader === '') {
    return { verified: false, kind: 'missing_signature_header', skewSeconds: null };
  }
  if (input.timestampHeader === null || input.timestampHeader === '') {
    return { verified: false, kind: 'missing_timestamp_header', skewSeconds: null };
  }

  // Stage 2: timestamp parse + skew check.
  const tsSeconds = Number.parseInt(input.timestampHeader, 10);
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) {
    return { verified: false, kind: 'malformed_timestamp', skewSeconds: null };
  }
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const skewSeconds = Math.abs(nowSeconds - tsSeconds);
  if (skewSeconds > input.maxSkewSeconds) {
    return { verified: false, kind: 'timestamp_skew_exceeded', skewSeconds };
  }

  // Stage 3: try active secret.
  const expectedActive = computeSignature(input.activeSecret, input.timestampHeader, input.rawBody);
  if (safeHexEqual(input.signatureHeader, expectedActive)) {
    return { verified: true, usedGraceSecret: false };
  }

  // Stage 4: try grace secret if grace window is open (per FR-008 / R7).
  const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
  if (input.graceSecret !== null && input.graceRotatedAt !== null) {
    const graceAgeMs = input.now.getTime() - input.graceRotatedAt.getTime();
    if (graceAgeMs <= GRACE_WINDOW_MS && graceAgeMs >= 0) {
      const expectedGrace = computeSignature(
        input.graceSecret,
        input.timestampHeader,
        input.rawBody,
      );
      if (safeHexEqual(input.signatureHeader, expectedGrace)) {
        return { verified: true, usedGraceSecret: true };
      }
    }
  }

  // All paths exhausted — generic mismatch.
  return { verified: false, kind: 'signature_mismatch', skewSeconds: null };
}

/**
 * Singleton adapter instance. Stateless — safe to share across
 * concurrent requests.
 */
export const cryptoWebhookSignatureVerifier: WebhookSignatureVerifier = {
  verify: verifyOnce,
};
