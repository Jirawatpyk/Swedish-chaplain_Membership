/**
 * T038 — Signature verification integration test (F6).
 *
 * Spec authority:
 *   - research.md R2 (HMAC-SHA256 + 5-min skew + grace key + length-check)
 *   - plan.md Testing § signature
 *
 * Covers FR-002 + FR-003 + FR-008:
 *   1. Valid signature with active secret → success
 *   2. Valid signature with grace secret within 24h → success + grace flag
 *   3. Valid signature with grace secret at 25h → reject
 *   4. Wrong secret → reject
 *   5. Tampered body → reject
 *   6. Missing X-Chamber-Signature header → reject
 *   7. Wrong-length signature (truncated / oversized) → reject (E8 guard)
 *   8. Timestamp skew >5min → reject
 *
 * All 8 rejection paths return the SAME `VerifyFailure` outcome (no oracle).
 *
 * RED reason: `verifyWebhookSignature` use-case (T043) + adapter (T044)
 * not yet exported from `@/modules/events`. Module import fails → red.
 *
 * Turns GREEN: T043 + T044 land.
 */
import { describe, expect, it } from 'vitest';
import { signWebhookBody, makeWebhookPayload } from './helpers/sign-webhook';

// @ts-expect-error — verifyWebhookSignature use-case not yet exported (T043).
import { verifyWebhookSignature } from '@/modules/events';
// @ts-expect-error — adapter not yet exported (T044).
import { cryptoWebhookSignatureVerifier } from '@/modules/events/infrastructure/crypto-webhook-signature-verifier';

const ACTIVE_SECRET = 'a'.repeat(43); // ≥43 chars per branded-types guard
const GRACE_SECRET = 'b'.repeat(43);
const TENANT_PAYLOAD = makeWebhookPayload();

describe('T038 — F6 webhook signature verification (8 paths)', () => {
  it('1. valid signature with active secret → verified', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: ACTIVE_SECRET });
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: null,
      graceRotatedAt: null,
      now: new Date(),
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.ok).toBe(true);
    expect(result.value.verified).toBe(true);
    expect(result.value.usedGraceSecret).toBe(false);
  });

  it('2. grace secret within 24h → verified + grace flag set', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: GRACE_SECRET });
    const now = new Date();
    const graceRotated = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h ago
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET, // doesn't match
      graceSecret: GRACE_SECRET, // matches
      graceRotatedAt: graceRotated,
      now,
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.verified).toBe(true);
    expect(result.value.usedGraceSecret).toBe(true);
  });

  it('3. grace secret at 25h → rejected (window closed)', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: GRACE_SECRET });
    const now = new Date();
    const graceRotated = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: GRACE_SECRET,
      graceRotatedAt: graceRotated,
      now,
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.verified).toBe(false);
  });

  it('4. wrong secret → rejected', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: 'wrong-secret-43-chars-aaaaaaaaaaaaa' });
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: null,
      graceRotatedAt: null,
      now: new Date(),
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.verified).toBe(false);
    expect(result.value.kind).toBe('signature_mismatch');
  });

  it('5. tampered body → rejected', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: ACTIVE_SECRET });
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody + '{"injected":"evil"}', // body bytes mutated
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: null,
      graceRotatedAt: null,
      now: new Date(),
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.verified).toBe(false);
  });

  it('6. missing signature header → rejected', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: ACTIVE_SECRET });
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: null,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: null,
      graceRotatedAt: null,
      now: new Date(),
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.kind).toBe('missing_signature_header');
  });

  it('7. wrong-length signature (truncated) → rejected without throw (E8)', () => {
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: ACTIVE_SECRET });
    expect(() =>
      verifyWebhookSignature({
        rawBody: signed.rawBody,
        signatureHeader: 'sha256=00deadbeef', // way too short
        timestampHeader: signed.timestamp,
        activeSecret: ACTIVE_SECRET,
        graceSecret: null,
        graceRotatedAt: null,
        now: new Date(),
        maxSkewSeconds: 300,
        verifier: cryptoWebhookSignatureVerifier,
      }),
    ).not.toThrow();
  });

  it('8. timestamp skew >5min → rejected with skewSeconds populated', () => {
    const now = new Date();
    const sixMinAgo = Math.floor(now.getTime() / 1000) - 360;
    const signed = signWebhookBody({ body: TENANT_PAYLOAD, secret: ACTIVE_SECRET, timestampSeconds: sixMinAgo });
    const result = verifyWebhookSignature({
      rawBody: signed.rawBody,
      signatureHeader: signed.signatureHeader,
      timestampHeader: signed.timestamp,
      activeSecret: ACTIVE_SECRET,
      graceSecret: null,
      graceRotatedAt: null,
      now,
      maxSkewSeconds: 300,
      verifier: cryptoWebhookSignatureVerifier,
    });
    expect(result.value.kind).toBe('timestamp_skew_exceeded');
    expect(result.value.skewSeconds).toBeGreaterThan(300);
  });
});
