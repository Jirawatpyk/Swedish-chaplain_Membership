/**
 * T101 — Unit tests for `verifyWebhookSignature` Application use-case (F6).
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/tasks.md T101 line 357
 *   - specs/012-eventcreate-integration/research.md R7 (24h grace key)
 *   - specs/012-eventcreate-integration/spec.md FR-008
 *
 * Why this file exists:
 *   The use-case `verifyWebhookSignature` is a thin pass-through that
 *   destructures the injected `WebhookSignatureVerifier` port and
 *   forwards the remaining input to `verifier.verify(rest)`. The
 *   verifier adapter (`crypto-webhook-signature-verifier.ts`) carries
 *   ALL HMAC + skew + grace-window branching and is covered by
 *   `tests/integration/events/signature.test.ts` (functionally a pure
 *   unit test — no DB, just deterministic crypto).
 *
 *   These tests prove the *wiring contract* — that the use-case
 *   forwards every outcome shape unchanged + strips the verifier
 *   from the input passed to the port. Adding branching logic later
 *   would break these tests immediately, catching that drift.
 *
 * Tests:
 *   1. verified=true + grace=false  → outcome returned unchanged
 *   2. verified=true + grace=true   → grace flag preserved
 *   3. verified=false signature_mismatch → outcome returned unchanged
 *   4. verified=false timestamp_skew_exceeded → skewSeconds preserved
 *   5. Verifier receives the input MINUS the `verifier` field
 */
import { describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '@/modules/events/application/use-cases/verify-webhook-signature';
import { asWebhookSecret } from '@/modules/events';
import type {
  WebhookSignatureVerifier,
  VerifyInput,
  VerifyOutcome,
} from '@/modules/events/application/ports/webhook-signature-verifier';

function makeBaseInput(): VerifyInput {
  return {
    rawBody: '{"event":"test"}',
    signatureHeader: 'sha256=' + 'a'.repeat(64),
    timestampHeader: String(Math.floor(Date.now() / 1000)),
    activeSecret: asWebhookSecret('a'.repeat(43)),
    graceSecret: null,
    graceRotatedAt: null,
    now: new Date(),
    maxSkewSeconds: 300,
  };
}

function makeStubVerifier(outcome: VerifyOutcome): WebhookSignatureVerifier & {
  readonly verify: ReturnType<typeof vi.fn>;
} {
  return { verify: vi.fn().mockReturnValue(outcome) };
}

describe('T101 — verifyWebhookSignature use-case (pure pass-through)', () => {
  it('1. forwards verified=true + grace=false outcome unchanged', () => {
    const expected: VerifyOutcome = { verified: true, usedGraceSecret: false };
    const verifier = makeStubVerifier(expected);

    const result = verifyWebhookSignature({ ...makeBaseInput(), verifier });

    expect(result).toEqual(expected);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it('2. forwards verified=true + grace=true outcome unchanged (FR-008 grace path)', () => {
    const expected: VerifyOutcome = { verified: true, usedGraceSecret: true };
    const verifier = makeStubVerifier(expected);

    const result = verifyWebhookSignature({
      ...makeBaseInput(),
      graceSecret: asWebhookSecret('b'.repeat(43)),
      graceRotatedAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12h ago
      verifier,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.usedGraceSecret).toBe(true);
    }
  });

  it('3. forwards verified=false + signature_mismatch outcome unchanged', () => {
    const expected: VerifyOutcome = {
      verified: false,
      kind: 'signature_mismatch',
      skewSeconds: null,
    };
    const verifier = makeStubVerifier(expected);

    const result = verifyWebhookSignature({ ...makeBaseInput(), verifier });

    expect(result).toEqual(expected);
  });

  it('4. preserves skewSeconds on timestamp_skew_exceeded (audit payload requirement)', () => {
    const expected: VerifyOutcome = {
      verified: false,
      kind: 'timestamp_skew_exceeded',
      skewSeconds: 600,
    };
    const verifier = makeStubVerifier(expected);

    const result = verifyWebhookSignature({ ...makeBaseInput(), verifier });

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.kind).toBe('timestamp_skew_exceeded');
      expect(result.skewSeconds).toBe(600);
    }
  });

  it('5. forwards input MINUS the verifier field to verifier.verify()', () => {
    const verifier = makeStubVerifier({ verified: true, usedGraceSecret: false });
    const base = makeBaseInput();

    verifyWebhookSignature({ ...base, verifier });

    expect(verifier.verify).toHaveBeenCalledTimes(1);
    const callArg = verifier.verify.mock.calls[0]?.[0];
    expect(callArg).toEqual(base);
    expect(callArg && 'verifier' in callArg).toBe(false);
  });
});
