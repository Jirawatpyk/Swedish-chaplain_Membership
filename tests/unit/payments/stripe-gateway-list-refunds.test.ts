/**
 * #50 — `stripeGateway.listRefundsForPaymentIntent`, the read the stale-pending
 * sweep uses to find out whether an orphan refund row (no processor id) ever
 * reached Stripe. It projects each refund to `{ id, status, appRefundId }`
 * only (PCI SAQ-A: no `destination_details`, no card fields) and says whether
 * the list is complete, so the sweep never closes a row on a partial answer.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const listMock = vi.fn();

vi.mock('@/modules/payments/infrastructure/stripe/stripe-client', () => ({
  getStripeClient: () => ({ refunds: { list: listMock } }),
  __resetStripeClientForTesting: () => {},
  __setStripeClientOverridesForTesting: () => {},
}));

import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';
import { env } from '@/lib/env';

const PLATFORM_ACCOUNT = env.stripe.accountIdSwecham;
const CONNECTED_ACCOUNT = 'acct_connected_tenant_test';

beforeEach(() => listMock.mockReset());

describe('stripeGateway.listRefundsForPaymentIntent', () => {
  it('lists by payment intent and projects id, status and our refund id only', async () => {
    listMock.mockResolvedValueOnce({
      data: [
        {
          id: 're_1',
          status: 'succeeded',
          metadata: { refundId: 'rfnd_ours', reason: 'free text' },
          destination_details: { card: { reference: 'ref_x' } },
        },
        { id: 're_2', status: null, metadata: {} },
      ],
      has_more: false,
    });

    const r = await stripeGateway.listRefundsForPaymentIntent('pi_1', CONNECTED_ACCOUNT);

    expect(listMock).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', limit: 100 },
      { stripeAccount: CONNECTED_ACCOUNT },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        refunds: [
          { id: 're_1', status: 'succeeded', appRefundId: 'rfnd_ours' },
          { id: 're_2', status: 'pending', appRefundId: null },
        ],
        complete: true,
      },
    });
    expect(JSON.stringify(r)).not.toContain('ref_x');
    expect(JSON.stringify(r)).not.toContain('free text');
  });

  it('has_more → complete: false (the sweep must not treat it as "none")', async () => {
    listMock.mockResolvedValueOnce({ data: [], has_more: true });
    const r = await stripeGateway.listRefundsForPaymentIntent('pi_1', PLATFORM_ACCOUNT);
    expect(listMock).toHaveBeenCalledWith({ payment_intent: 'pi_1', limit: 100 }, {});
    expect(r.ok && r.value.complete).toBe(false);
  });

  it('a Stripe error maps through mapStripeError (connection → retryable)', async () => {
    listMock.mockRejectedValueOnce(Object.assign(new Error('down'), { type: 'StripeConnectionError' }));
    const r = await stripeGateway.listRefundsForPaymentIntent('pi_1', PLATFORM_ACCOUNT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('retryable');
  });
});
