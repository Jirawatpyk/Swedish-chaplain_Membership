/**
 * Unit test for `stripeGateway.retrieveRefund` (PR-A Task A.8 / PCI-3).
 *
 * `retrieveRefund` is a thin read wrapper the Stripe-aware sweep (A.14)
 * uses to reconcile a `refunds` row against Stripe's own state. PCI
 * SAQ-A requires it project ONLY an allow-listed 5-field VO
 * (`{id, status, chargeId, paymentIntentId, amountSatang}`) — the raw
 * Stripe `Refund` carries `destination_details` (card brand/network/
 * last4-shaped reference data) which must NEVER cross the Infrastructure
 * boundary into Application.
 *
 * Mirrors the mocking pattern of
 * `tests/unit/payments/infrastructure/stripe-gateway-retrieve-retry.test.ts`
 * — mock the Stripe client singleton directly (not MSW) so we can
 * control the exact response shape and assert the projected VO +
 * `connectOptions` Connect-scoping call args deterministically.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';

const retrieveMock = vi.fn();

vi.mock(
  '@/modules/payments/infrastructure/stripe/stripe-client',
  () => ({
    getStripeClient: () => ({
      refunds: { retrieve: retrieveMock },
    }),
    __resetStripeClientForTesting: () => {},
    __setStripeClientOverridesForTesting: () => {},
  }),
);

import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';
import { env } from '@/lib/env';

// The platform's own account — `connectOptions` omits `stripeAccount`
// when the target IS the platform (see stripe-gateway.ts
// `shouldActOnBehalfOf`). A distinct literal simulates a genuinely
// Connect-scoped (future multi-tenant) account.
const PLATFORM_ACCOUNT = env.stripe.accountIdSwecham;
const CONNECTED_ACCOUNT = 'acct_connected_tenant_test';
const REFUND_ID = 're_test_retrieve_a8';

/**
 * A synthetic Stripe Refund carrying BOTH `destination_details.card`
 * (PCI-sensitive nested card data) AND an expanded `charge` object
 * (which itself embeds `payment_method_details.card`) — the exact
 * shape a real Stripe response would have on a card refund. The test
 * proves the gateway drops all of it and returns ONLY the 5
 * allow-listed fields.
 */
function syntheticRefund(
  overrides: Partial<Stripe.Refund> = {},
): Stripe.Refund {
  return {
    id: REFUND_ID,
    object: 'refund',
    status: 'succeeded',
    amount: 12345,
    currency: 'thb',
    charge: {
      id: 'ch_test_expanded_a8',
      object: 'charge',
      payment_method_details: {
        type: 'card',
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
      },
    } as unknown as Stripe.Charge,
    payment_intent: 'pi_test_retrieve_a8',
    destination_details: {
      type: 'card',
      card: {
        reference: 'ref_abc123',
        reference_status: 'available',
        reference_type: 'acquirer_reference_number',
      },
    } as unknown as Stripe.Refund.DestinationDetails,
    metadata: {},
    reason: null,
    receipt_number: null,
    ...overrides,
  } as unknown as Stripe.Refund;
}

beforeEach(() => {
  retrieveMock.mockReset();
});

describe('stripeGateway.retrieveRefund — PCI-3 allow-list', () => {
  it('projects ONLY the 5 allow-listed fields — no destination_details, no card keys', async () => {
    retrieveMock.mockResolvedValueOnce(syntheticRefund());

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    expect(result.value).toEqual({
      id: REFUND_ID,
      status: 'succeeded',
      chargeId: 'ch_test_expanded_a8',
      paymentIntentId: 'pi_test_retrieve_a8',
      amountSatang: 12345n,
    });

    // Negative-assert: EXACTLY these 5 keys — nothing extra leaked
    // through (destination_details, metadata, reason, receipt_number,
    // or any card-shaped field).
    expect(Object.keys(result.value).sort()).toEqual(
      ['amountSatang', 'chargeId', 'id', 'paymentIntentId', 'status'].sort(),
    );
    expect(result.value).not.toHaveProperty('destination_details');
    expect(result.value).not.toHaveProperty('destinationDetails');
    expect(result.value).not.toHaveProperty('card');
    expect(result.value).not.toHaveProperty('metadata');
    expect(result.value).not.toHaveProperty('receipt_number');

    // Belt-and-suspenders: the serialised VO must not contain any of
    // the PCI-sensitive card fields from the raw Stripe response, even
    // nested.
    const serialised = JSON.stringify(result.value, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialised).not.toContain('reference_status');
    expect(serialised).not.toContain('brand');
    expect(serialised).not.toContain('last4');
    expect(serialised).not.toContain('exp_month');
  });

  it('defensive extraction: string chargeId/paymentIntentId (non-expanded) are used as-is', async () => {
    retrieveMock.mockResolvedValueOnce(
      syntheticRefund({
        charge: 'ch_string_only',
        payment_intent: 'pi_string_only',
      }),
    );

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.chargeId).toBe('ch_string_only');
    expect(result.value.paymentIntentId).toBe('pi_string_only');
  });

  it('defensive extraction: null charge/payment_intent → null (never throws)', async () => {
    retrieveMock.mockResolvedValueOnce(
      syntheticRefund({ charge: null, payment_intent: null }),
    );

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.chargeId).toBeNull();
    expect(result.value.paymentIntentId).toBeNull();
  });

  it('status null → falls back to "pending" (mirrors createRefund)', async () => {
    retrieveMock.mockResolvedValueOnce(syntheticRefund({ status: null }));

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.status).toBe('pending');
  });

  it('defensive amount projection: non-finite/negative Stripe amount → typed permanent error (no fallback, pure read)', async () => {
    retrieveMock.mockResolvedValueOnce(syntheticRefund({ amount: -5 }));

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('permanent');
    if (result.error.kind !== 'permanent') throw new Error('unreachable');
    expect(result.error.code).toBe('processor_response_amount_invalid');
  });

  it('connectOptions applied when stripeAccount !== platform account', async () => {
    retrieveMock.mockResolvedValueOnce(syntheticRefund());

    await stripeGateway.retrieveRefund(REFUND_ID, CONNECTED_ACCOUNT);

    expect(retrieveMock).toHaveBeenCalledWith(REFUND_ID, undefined, {
      stripeAccount: CONNECTED_ACCOUNT,
    });
  });

  it('connectOptions omits stripeAccount when target IS the platform account', async () => {
    retrieveMock.mockResolvedValueOnce(syntheticRefund());

    await stripeGateway.retrieveRefund(REFUND_ID, PLATFORM_ACCOUNT);

    expect(retrieveMock).toHaveBeenCalledWith(REFUND_ID, undefined, {});
  });

  it('Stripe SDK error → mapped via mapStripeError (permanent for resource_missing)', async () => {
    const Stripe = (await import('stripe')).default;
    retrieveMock.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'No such refund',
        type: 'StripeInvalidRequestError' as never,
        code: 'resource_missing',
        statusCode: 404,
      }),
    );

    const result = await stripeGateway.retrieveRefund(
      REFUND_ID,
      PLATFORM_ACCOUNT,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('permanent');
  });

  it('logs allow-list ONLY {stripeAccount, refundId, status} on success', async () => {
    const { logger } = await import('@/lib/logger');
    const infoSpy = vi.spyOn(logger, 'info');
    retrieveMock.mockResolvedValueOnce(syntheticRefund());

    await stripeGateway.retrieveRefund(REFUND_ID, PLATFORM_ACCOUNT);

    const call = infoSpy.mock.calls.find(
      ([, msg]) =>
        typeof msg === 'string' && msg.includes('retrieveRefund'),
    );
    expect(call).toBeDefined();
    const payload = call?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ['refundId', 'status', 'stripeAccount'].sort(),
    );
  });
});
