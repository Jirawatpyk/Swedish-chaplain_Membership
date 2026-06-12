/**
 * Unit test for the bounded retry-with-backoff on
 * `stripeGateway.retrievePaymentIntent` (fix/068).
 *
 * Context (root cause, diagnosed 2026-06-12): when the
 * `payment_intent.succeeded` webhook fires, `confirmPayment` step 6
 * re-fetches the PaymentIntent for card metadata (brand/last4). Stripe
 * webhook read-consistency means the object is INTERMITTENTLY not yet
 * retrievable right when the event fires — the retrieve throws a
 * `StripeInvalidRequestError` with `code: 'resource_missing'` / HTTP
 * 404. `mapStripeError` classifies that as `permanent` (default case),
 * so it was NOT retried → the payment row landed `method='other'` with
 * no card brand/last4 (UI shows "Other").
 *
 * The retrieve is IDEMPOTENT, so a tight bounded retry on the
 * webhook-read-lag shape self-heals the metadata loss within the same
 * handler. This test mocks the Stripe client directly (NOT MSW) so we
 * can drive the per-attempt behaviour + count `retrieve` invocations.
 *
 * Fake timers are installed so the backoff delays resolve instantly —
 * the test asserts the retry COUNT + final Result, not wall-clock time.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Mock the Stripe client singleton so the gateway calls OUR stub
// `paymentIntents.retrieve`. `vi.mock` is hoisted; the factory returns
// a controllable mock whose behaviour each test sets up via
// `retrieveMock.mockImplementationOnce(...)`.
// ---------------------------------------------------------------------------
const retrieveMock = vi.fn();

vi.mock(
  '@/modules/payments/infrastructure/stripe/stripe-client',
  () => ({
    getStripeClient: () => ({
      paymentIntents: { retrieve: retrieveMock },
    }),
    // The gateway imports only `getStripeClient`; the test-only seams
    // are unused here but kept as no-ops so any incidental import resolves.
    __resetStripeClientForTesting: () => {},
    __setStripeClientOverridesForTesting: () => {},
  }),
);

import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';

const STRIPE_ACCOUNT = 'acct_test_retry';
const PI_ID = 'pi_test_retry_068';

/**
 * A fully-populated PaymentIntent (expanded `latest_charge.payment_method_details.card`)
 * shaped like Stripe's retrieve response, so `extractCardMetadata`
 * returns real card metadata on success.
 */
function piWithCard(): Stripe.PaymentIntent {
  return {
    id: PI_ID,
    object: 'payment_intent',
    status: 'succeeded',
    client_secret: `${PI_ID}_secret_abc`,
    livemode: false,
    last_payment_error: null,
    next_action: null,
    latest_charge: {
      id: 'ch_test_068',
      object: 'charge',
      payment_method_details: {
        type: 'card',
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
        },
      },
    } as unknown as Stripe.Charge,
  } as unknown as Stripe.PaymentIntent;
}

/**
 * The classic webhook-read-lag shape: object not yet readable.
 * `StripeInvalidRequestError` + `code: 'resource_missing'` + HTTP 404.
 * `mapStripeError`'s default arm classifies this `permanent`.
 */
function resourceMissingError(): Stripe.errors.StripeInvalidRequestError {
  return new Stripe.errors.StripeInvalidRequestError({
    message: 'No such payment_intent: pi_test_retry_068',
    type: 'StripeInvalidRequestError' as never,
    code: 'resource_missing',
    statusCode: 404,
  });
}

beforeEach(() => {
  retrieveMock.mockReset();
  // Fake timers so the backoff `setTimeout` delays resolve instantly.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

/**
 * Drive a gateway call to completion while advancing fake timers so the
 * internal backoff `setTimeout`s fire. We await microtasks between timer
 * advances so each attempt's promise settles before the next delay.
 */
async function runWithTimers<T>(p: Promise<T>): Promise<T> {
  // Flush any pending timers repeatedly until the promise settles. Each
  // backoff is scheduled only after the prior attempt rejects, so we
  // interleave runAllTimersAsync with the awaited promise.
  await vi.runAllTimersAsync();
  return p;
}

describe('stripeGateway.retrievePaymentIntent — bounded webhook-read-lag retry', () => {
  it('transient resource_missing on attempt 1, then succeeds on attempt 2 → resolves OK with card metadata (recovery)', async () => {
    retrieveMock
      .mockRejectedValueOnce(resourceMissingError())
      .mockResolvedValueOnce(piWithCard());

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // The retry recovered the card metadata that the first attempt lost.
    expect(result.value.card).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
    // Called twice: failed attempt 1 + successful attempt 2.
    expect(retrieveMock).toHaveBeenCalledTimes(2);
  });

  it('persistent resource_missing on every attempt → gives up after the bounded attempts and returns the mapped permanent err (no infinite loop)', async () => {
    retrieveMock.mockRejectedValue(resourceMissingError());

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    // Exhaustion preserves the SAME mapped classification as today
    // (resource_missing → permanent) so confirm-payment's existing
    // audit + `processor_unavailable` path is unchanged.
    expect(result.error.kind).toBe('permanent');
    if (result.error.kind !== 'permanent') throw new Error('unreachable');
    expect(result.error.code).toBe('resource_missing');
    // Bounded: exactly MAX_RETRIEVE_ATTEMPTS (3) calls, never more.
    expect(retrieveMock).toHaveBeenCalledTimes(3);
  });

  it('non-retryable permanent (genuine invalid params) → NOT retried, returns immediately (no added latency on real failures)', async () => {
    const e = new Stripe.errors.StripeInvalidRequestError({
      message: 'Invalid integer: amount',
      type: 'StripeInvalidRequestError' as never,
      code: 'parameter_invalid_integer',
      statusCode: 400,
    });
    retrieveMock.mockRejectedValue(e);

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('permanent');
    // Called exactly once — a genuine permanent error is not a
    // webhook-read-lag shape, so we do not retry it.
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });

  it('idempotency_conflict → NOT retried (called once)', async () => {
    // Defensive: a retrieve never carries an idempotency key, but prove
    // the retry signal does not accidentally loop on idempotency errors.
    const e = new Stripe.errors.StripeIdempotencyError({
      message: 'Idempotency key in use',
      type: 'StripeIdempotencyError' as never,
      code: 'idempotency_key_in_use',
    });
    retrieveMock.mockRejectedValue(e);

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('idempotency_conflict');
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });

  it('success on first try → called once, OK (no regression / no added latency on happy path)', async () => {
    retrieveMock.mockResolvedValueOnce(piWithCard());

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.card?.last4).toBe('4242');
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });

  it('network/rate-limit error → NOT re-handled at this layer (mapped retryable, called once — SDK already retried under the hood)', async () => {
    // The SDK's own `maxNetworkRetries: 3` handles transport-level
    // retries; by the time a connection error bubbles to the gateway it
    // is final. `mapStripeError` classifies it `retryable` so the webhook
    // re-delivers. Our webhook-read-lag retry must NOT double-handle it.
    const e = new Stripe.errors.StripeConnectionError({
      message: 'Could not connect to Stripe',
      type: 'StripeConnectionError' as never,
    });
    retrieveMock.mockRejectedValue(e);

    const result = await runWithTimers(
      stripeGateway.retrievePaymentIntent(PI_ID, STRIPE_ACCOUNT),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('retryable');
    expect(retrieveMock).toHaveBeenCalledTimes(1);
  });
});
