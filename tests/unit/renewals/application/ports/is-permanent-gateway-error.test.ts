/**
 * K6 — direct unit test for `isPermanentGatewayError` classifier.
 *
 * The classifier is consumed by BOTH `dispatchOneCycle` AND
 * `retryFailedReminders` (Wave J12-S7 dedup) so a policy drift here
 * silently drifts both code paths. Indirect coverage was via downstream
 * tests (gateway_4xx + recipient_unsubscribed) but `recipient_email_
 * unverified` and `template_variables_missing` were only exercised at
 * the gateway-adapter level — never against the classifier itself.
 *
 * This test pins all 4 permanent-kinds → `true` and the 1 transient
 * kind → `false`. Adding a new SendRenewalEmailError variant without
 * extending the classifier now produces a TS exhaustiveness gap that
 * this test will surface (the casts ensure the test compiles only when
 * the kind literal exists in the union).
 */
import { describe, expect, it } from 'vitest';
import {
  isPermanentGatewayError,
  type SendRenewalEmailError,
} from '@/modules/renewals/application/ports/renewal-gateway';

describe('isPermanentGatewayError (K6)', () => {
  it('returns true for gateway_4xx', () => {
    const err: SendRenewalEmailError = {
      kind: 'gateway_4xx',
      retryable: false,
      message: '422 invalid recipient',
    };
    expect(isPermanentGatewayError(err)).toBe(true);
  });

  it('returns true for recipient_unsubscribed', () => {
    const err: SendRenewalEmailError = { kind: 'recipient_unsubscribed' };
    expect(isPermanentGatewayError(err)).toBe(true);
  });

  it('returns true for recipient_email_unverified', () => {
    const err: SendRenewalEmailError = { kind: 'recipient_email_unverified' };
    expect(isPermanentGatewayError(err)).toBe(true);
  });

  it('returns true for template_variables_missing', () => {
    const err: SendRenewalEmailError = {
      kind: 'template_variables_missing',
      missing: ['offset_day'],
    };
    expect(isPermanentGatewayError(err)).toBe(true);
  });

  it('returns false for gateway_5xx (transient — eligible for retry)', () => {
    const err: SendRenewalEmailError = {
      kind: 'gateway_5xx',
      retryable: true,
      message: 'upstream timeout',
    };
    expect(isPermanentGatewayError(err)).toBe(false);
  });

  it('K12-S (TST-K-1 + CON-K-2): exhaustiveness defence — unknown future variant returns false', () => {
    // The classifier converted to switch + `never` exhaustiveness in
    // CON-K-2 — a new variant that bypasses the switch falls through
    // to the default branch which returns false (transient bias) and
    // would fail compile if added to the union without a switch arm.
    // This test pins the runtime fallback so a `// @ts-expect-error`
    // bypass during refactoring is still caught at runtime.
    const future = { kind: 'unknown_future_variant' } as unknown as SendRenewalEmailError;
    expect(isPermanentGatewayError(future)).toBe(false);
  });
});
