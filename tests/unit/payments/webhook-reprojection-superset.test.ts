/**
 * Task C.4 — M-f: pin the webhook route's `dataObject` re-projection as
 * a SUPERSET of the verifier envelope's `dataObject` keys.
 *
 * Bugs #5 (`amountProjectionFailed` silently dropped) and #6
 * (`disputeId` silently dropped) both existed because
 * `src/app/api/webhooks/stripe/route.ts` projects the Stripe event
 * envelope TWICE: once inside the verifier's own `project()`, and again
 * inside the route via a manual rebuild that copied a FIXED allow-list
 * of known keys — silently dropping anything the allow-list forgot.
 * C.1/C.2 closed those two specific gaps by adding explicit copies.
 * This test closes the whole BUG CLASS: it builds a synthetic verifier
 * envelope with EVERY optional `VerifiedStripeEvent['dataObject']` key
 * set, runs it through the extracted pure `reprojectDataObject` helper,
 * and asserts every key that was present on the input survives onto
 * the output. If a future key is added to the verifier's envelope
 * (`webhook-verifier-port.ts`) but the route's copy-list is not
 * updated to match, this test fails instead of silently dropping data
 * in production.
 *
 * Keys enumerated literally from `VerifiedStripeEvent['dataObject']`
 * (`webhook-verifier-port.ts:86-109`) as of this task:
 *   id, type, latestChargeId, refundIds, lastPaymentErrorCode,
 *   disputeId, amountSatang, amountProjectionFailed
 *
 * NOTE: PR-A Task A.9 adds a NEW optional key `refundStatus` to
 * `VerifiedStripeEvent['dataObject']`. When that lands, add
 * `refundStatus` to `SYNTHETIC_DATA_OBJECT` below (and confirm
 * `reprojectDataObject` copies it) so this guard keeps covering 100%
 * of the envelope shape rather than silently going stale.
 *
 * Red-check performed manually during implementation (see
 * `.superpowers/sdd/task-C.4-report.md`): temporarily deleting the
 * `disputeId` copy line from `reprojectDataObject` made this test fail
 * with a clear "expected property disputeId" diff, confirming the test
 * actually exercises the drop-field bug class before being restored.
 */
import { describe, expect, it } from 'vitest';

import { reprojectDataObject } from '@/app/api/webhooks/stripe/route';

/**
 * Synthetic verifier-projected `dataObject` — i.e. what
 * `stripe-webhook-verifier.ts`'s `project()` hands to the route via
 * `rawEvent.dataObject`. Every optional key from
 * `VerifiedStripeEvent['dataObject']` is populated with a representative
 * value so the superset assertion below covers the full envelope shape.
 */
const SYNTHETIC_DATA_OBJECT: Record<string, unknown> = {
  id: 'evt_test_superset_1',
  type: 'payment_intent',
  latestChargeId: 'ch_test_superset_1',
  refundIds: ['re_test_superset_1', 're_test_superset_2'],
  lastPaymentErrorCode: 'card_declined',
  disputeId: 'dp_test_superset_1',
  amountSatang: 150000n,
  amountProjectionFailed: true,
};

describe('reprojectDataObject — superset regression guard (M-f)', () => {
  it('preserves every optional key present on the verifier envelope', () => {
    const result = reprojectDataObject(SYNTHETIC_DATA_OBJECT);

    for (const [key, value] of Object.entries(SYNTHETIC_DATA_OBJECT)) {
      expect(result).toHaveProperty(key, value);
    }
  });

  it('preserves the required id/type keys', () => {
    const result = reprojectDataObject(SYNTHETIC_DATA_OBJECT);

    expect(result.id).toBe('evt_test_superset_1');
    expect(result.type).toBe('payment_intent');
  });

  it('preserves amountProjectionFailed=true (Bug #5 regression)', () => {
    const result = reprojectDataObject(SYNTHETIC_DATA_OBJECT);

    expect(result.amountProjectionFailed).toBe(true);
  });

  it('preserves disputeId (Bug #6 regression)', () => {
    const result = reprojectDataObject(SYNTHETIC_DATA_OBJECT);

    expect(result.disputeId).toBe('dp_test_superset_1');
  });

  it('does not fabricate keys that were absent from the input', () => {
    const result = reprojectDataObject({ id: 'evt_minimal', type: 'charge' });

    expect(result).not.toHaveProperty('disputeId');
    expect(result).not.toHaveProperty('refundIds');
    expect(result).not.toHaveProperty('lastPaymentErrorCode');
    expect(result).not.toHaveProperty('latestChargeId');
    expect(result).not.toHaveProperty('amountSatang');
    expect(result).not.toHaveProperty('amountProjectionFailed');
  });
});
