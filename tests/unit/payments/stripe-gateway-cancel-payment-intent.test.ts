/**
 * #731 (task 52) — `stripeGateway.cancelPaymentIntent` on Stripe's
 * `payment_intent_unexpected_state`. A PaymentIntent that is `processing` or
 * `requires_capture` can still be charged, so it must come back as an explicit
 * `payment_intent_not_cancelable`, never the generic permanent mapping the
 * cross-method switch used to read as "safe to mark canceled".
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const cancelMock = vi.fn();
const retrieveMock = vi.fn();

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/payments/infrastructure/stripe/stripe-client', () => ({
  getStripeClient: () => ({ paymentIntents: { cancel: cancelMock, retrieve: retrieveMock } }),
  __resetStripeClientForTesting: () => {},
  __setStripeClientOverridesForTesting: () => {},
}));

import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';

const ACCOUNT = 'acct_connected_tenant_test';

function unexpectedState(): Error {
  return Object.assign(new Error('This PaymentIntent cannot be canceled'), {
    type: 'StripeInvalidRequestError',
    code: 'payment_intent_unexpected_state',
  });
}

beforeEach(() => {
  cancelMock.mockReset();
  retrieveMock.mockReset();
});

describe('stripeGateway.cancelPaymentIntent — unexpected_state', () => {
  it.each(['processing', 'requires_capture'])(
    'a %s PI is payment_intent_not_cancelable (it can still be charged)',
    async (status) => {
      cancelMock.mockRejectedValueOnce(unexpectedState());
      retrieveMock.mockResolvedValueOnce({ id: 'pi_1', status });
      const r = await stripeGateway.cancelPaymentIntent('pi_1', ACCOUNT);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('permanent');
      if (r.error.kind !== 'permanent') return;
      expect(r.error.code).toBe('payment_intent_not_cancelable');
    },
  );

  it('an already-canceled PI is ok (idempotent)', async () => {
    cancelMock.mockRejectedValueOnce(unexpectedState());
    retrieveMock.mockResolvedValueOnce({ id: 'pi_1', status: 'canceled' });
    const r = await stripeGateway.cancelPaymentIntent('pi_1', ACCOUNT);
    expect(r.ok).toBe(true);
  });

  it('a succeeded PI is payment_intent_already_succeeded', async () => {
    cancelMock.mockRejectedValueOnce(unexpectedState());
    retrieveMock.mockResolvedValueOnce({ id: 'pi_1', status: 'succeeded' });
    const r = await stripeGateway.cancelPaymentIntent('pi_1', ACCOUNT);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.kind !== 'permanent') throw new Error('expected a permanent error');
    expect(r.error.code).toBe('payment_intent_already_succeeded');
  });
});
