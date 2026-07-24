/**
 * Money-remediation Task 9 (F-9) — app-initiated refund marker projection.
 *
 * `issueRefund` stamps `metadata.refundId` on the Stripe Refund BEFORE the
 * external `createRefund` call (`issue-refund.ts:629`). That marker is the ONLY
 * key that exists during the window where `charge.refunded` can arrive ahead of
 * `attachProcessorRefundId` — the window that fires a false 10-year
 * `out_of_band_refund_detected` plus an on-call page for a refund the app
 * itself initiated.
 *
 * The marker is attacker-influenceable: anyone with Stripe Dashboard access —
 * the exact actor the OOB alert exists to catch — can set `metadata.refundId`
 * on a hand-made refund. The verifier's job is therefore strictly to validate
 * the FORMAT and forward; suppression authority lives in the handlers, gated on
 * three further mitigations (IS NULL predicate, tenant filter, PI cross-check).
 *
 * Uses the REAL Stripe SDK for signatures — pure crypto, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { stripeWebhookVerifier } from '@/modules/payments/infrastructure/stripe/stripe-webhook-verifier';
import { logger } from '@/lib/logger';

const ENDPOINT_SECRET = 'whsec_test_f9_marker_fixture_secret';

function makeSigHeader(body: string): string {
  return Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: ENDPOINT_SECRET,
  });
}

function signedEvent(dataObject: Record<string, unknown>, type: string): string {
  return JSON.stringify({
    id: `evt_f9_${Math.random().toString(36).slice(2, 10)}`,
    type,
    api_version: '2025-09-30.clover',
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    account: 'acct_test_f9',
    data: { object: dataObject },
  });
}

function project(dataObject: Record<string, unknown>, type: string) {
  const body = signedEvent(dataObject, type);
  return stripeWebhookVerifier.constructEvent(
    body,
    makeSigHeader(body),
    ENDPOINT_SECRET,
  ).dataObject;
}

describe('F-9 verifier — app-refund marker format', () => {
  /**
   * THE FORMAT-DRIFT GUARD.
   *
   * The remediation plan mandated "uuid-validated" markers. Every real refund
   * id is `rfnd_<32 hex>` (37 chars) — migration 0243 records the same fact in
   * as many words — so a uuid matcher would reject 100% of genuine markers and
   * leave the F-9 fallback permanently dead, while the over-correction control
   * stayed green. A mitigation that fails in the direction that looks like
   * success.
   *
   * Asserts against a value from the REAL generator rather than a hand-written
   * literal, because a hardcoded fixture is exactly how that drift survives: a
   * literal keeps matching whatever regex you wrote it to match.
   */
  it('accepts a marker produced by the real generateRefundId() shape', () => {
    // Byte-for-byte the production generator (`di.ts` generateRefundId).
    const realRefundId = `rfnd_${randomUUID().replace(/-/g, '')}`;

    const dataObject = project(
      {
        id: 're_real_gen',
        object: 'refund',
        status: 'succeeded',
        charge: 'ch_real_gen',
        payment_intent: 'pi_real_gen',
        amount: 50_000,
        metadata: { refundId: realRefundId },
      },
      'refund.updated',
    );

    expect(dataObject.appRefundIds).toEqual({ re_real_gen: realRefundId });
    expect(dataObject.paymentIntentId).toBe('pi_real_gen');
  });

  it('charge arm: maps EACH refund node carrying a marker, keyed by re_ id', () => {
    const dataObject = project(
      {
        id: 'ch_multi',
        object: 'charge',
        payment_intent: 'pi_multi',
        amount: 100_000,
        refunds: {
          data: [
            {
              id: 're_app',
              metadata: { refundId: 'rfnd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
            },
            // A genuine Stripe-Dashboard refund on the SAME charge — no marker.
            // Must stay absent so the OOB forensic still fires for it while its
            // app-initiated sibling is suppressed.
            { id: 're_dashboard' },
          ],
        },
      },
      'charge.refunded',
    );

    expect(dataObject.refundIds).toEqual(['re_app', 're_dashboard']);
    expect(dataObject.appRefundIds).toEqual({
      re_app: 'rfnd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(dataObject.appRefundIds).not.toHaveProperty('re_dashboard');
    expect(dataObject.paymentIntentId).toBe('pi_multi');
  });

  it('drops a malformed marker and logs it (forgery / SDK-drift signal)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      // Injection attempt — rejected by RE_ULID_LIKE's bounded charset. This
      // matters because `refunds.id` is `text`, not `uuid`, at the DB level
      // (0034_create_refunds.sql:15), so nothing downstream would reject a
      // forged marker on a cast. The verifier is the only gate.
      const forged = ['rfnd_x', "'; DROP TABLE refunds;--"].join('');

      const dataObject = project(
        {
          id: 're_bad',
          object: 'refund',
          status: 'succeeded',
          payment_intent: 'pi_bad',
          amount: 1_000,
          metadata: { refundId: forged },
        },
        'refund.updated',
      );

      expect(dataObject.appRefundIds).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // PCI / injection hygiene: the forged VALUE must never reach the log.
      const logged = JSON.stringify(warnSpy.mock.calls[0]);
      expect(logged).toContain('app_refund_marker_malformed');
      expect(logged).not.toContain('DROP TABLE');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('absent metadata stays silent — a Dashboard refund is not an anomaly', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const dataObject = project(
        {
          id: 're_plain',
          object: 'refund',
          status: 'succeeded',
          payment_intent: 'pi_plain',
          amount: 1_000,
        },
        'refund.updated',
      );

      expect(dataObject.appRefundIds).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('F-9 verifier — paymentIntentId (anti-forgery cross-check input)', () => {
  /**
   * The `latest_charge` (#13) / dispute-`charge` (PCI-2) bug class, applied to
   * `payment_intent`. A bare `typeof === 'string'` narrowing silently yields
   * nothing on an expanded object, which would make the cross-check
   * unsatisfiable — the same dead-mitigation shape as the uuid regex, one
   * layer down.
   */
  it('extracts the id from an EXPANDED PaymentIntent object, leaking nothing', () => {
    const dataObject = project(
      {
        id: 're_exp',
        object: 'refund',
        status: 'succeeded',
        amount: 1_000,
        payment_intent: {
          id: 'pi_expanded',
          object: 'payment_intent',
          // Must not survive projection (PCI SAQ-A).
          charges: {
            data: [
              {
                payment_method_details: {
                  card: { last4: '4242', brand: 'visa' },
                },
              },
            ],
          },
        },
      },
      'refund.updated',
    );

    expect(dataObject.paymentIntentId).toBe('pi_expanded');
    const serialized = JSON.stringify(dataObject, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain('4242');
    expect(serialized).not.toContain('payment_method_details');
  });

  it('projects null when the field is absent (consumer must NOT suppress)', () => {
    const dataObject = project(
      { id: 're_nopi', object: 'refund', status: 'succeeded', amount: 1_000 },
      'refund.updated',
    );

    expect(dataObject.paymentIntentId).toBeNull();
  });

  it('projects null when payment_intent is an object without an id', () => {
    const dataObject = project(
      {
        id: 're_weird',
        object: 'refund',
        status: 'succeeded',
        amount: 1_000,
        payment_intent: { object: 'payment_intent' },
      },
      'refund.updated',
    );

    expect(dataObject.paymentIntentId).toBeNull();
  });
});
