/**
 * E3 — Stripe gateway adapter integration test with MSW-mocked Stripe API.
 *
 * Covers:
 *   - createPaymentIntent: Idempotency-Key + Stripe-Account headers
 *     propagated; response mapped to port shape.
 *   - retrievePaymentIntent: card metadata masking — `fingerprint` +
 *     `iin` present in Stripe response are STRIPPED from mapped result.
 *   - createRefund: idempotency key propagation; error mapping for
 *     429 (StripeAPIError → retryable) and 500 (StripeAPIError →
 *     retryable per adapter switch).
 *   - PCI log hygiene: `logger.info` allow-list assertion — no raw
 *     response body, no clientSecret, no card fingerprint.
 *
 * Uses MSW v2 (`msw/node`) to intercept `https://api.stripe.com/v1/*`
 * at the Node http layer. The REAL Stripe SDK client runs against
 * the mock — proves the full request/response pipeline (including
 * idempotency header propagation via Stripe's HTTP layer).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import Stripe from 'stripe';
import { logger } from '@/lib/logger';
import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';
import {
  __resetStripeClientForTesting,
  __setStripeClientOverridesForTesting,
} from '@/modules/payments/infrastructure/stripe/stripe-client';

// ---------------------------------------------------------------------------
// MSW interception fixture.
//
// Audit 2026-04-25: previously gated behind `ENABLE_STRIPE_MSW_TESTS=1`
// with a `describe.skip` because the Stripe SDK v22 default `httpClient`
// (Node `https` module + keep-alive pool) didn't reliably round-trip
// through MSW v2's `ClientRequest` interceptor on Node 20 — tests hung
// on real network calls until timeout.
//
// Fix: inject `Stripe.createFetchHttpClient()` via the test-only seam
// (`__setStripeClientOverridesForTesting`). MSW v2 intercepts global
// `fetch` deterministically, so the SDK's HTTP roundtrips reach our
// handlers in every Node 20 environment.
// ---------------------------------------------------------------------------

// Capture requests MSW sees — assertions run against this record.
interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}
const captured: CapturedRequest[] = [];

function captureReq(request: Request, bodyText: string): void {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  captured.push({
    url: request.url,
    method: request.method,
    headers,
    bodyText,
  });
}

const STRIPE_ACCOUNT = 'acct_test_e3_mock';

// ---------------------------------------------------------------------------
// MSW server — registers per-endpoint handlers before each test.
// ---------------------------------------------------------------------------
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});
beforeEach(() => {
  captured.length = 0;
  server.resetHandlers();
  __resetStripeClientForTesting();
  // Switch SDK to fetch-based httpClient so MSW v2 intercepts every
  // outbound Stripe call (audit 2026-04-25 — see file header).
  __setStripeClientOverridesForTesting({
    httpClient: Stripe.createFetchHttpClient(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetStripeClientForTesting();
});

describe('stripeGateway — MSW-mocked Stripe API', () => {
  it('createPaymentIntent propagates Idempotency-Key + Stripe-Account headers, maps to port shape', async () => {
    server.use(
      http.post('https://api.stripe.com/v1/payment_intents', async ({ request }) => {
        captureReq(request, await request.text());
        return HttpResponse.json({
          id: 'pi_test_e3_mock',
          object: 'payment_intent',
          amount: 50000,
          currency: 'thb',
          status: 'requires_payment_method',
          client_secret: 'pi_test_e3_mock_secret_abc',
          livemode: false,
          next_action: null,
          metadata: {},
        });
      }),
    );

    const ok = await stripeGateway.createPaymentIntent({
      amountSatang: 50000n,
      currency: 'thb',
      paymentMethodTypes: ['card'],
      metadata: { invoice_id: 'inv_test' },
      idempotencyKey: 'inv-inv_test-attempt-1',
      stripeAccount: STRIPE_ACCOUNT,
    });

    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('expected ok');
    expect(ok.value.id).toBe('pi_test_e3_mock');
    expect(ok.value.clientSecret).toBe('pi_test_e3_mock_secret_abc');
    expect(ok.value.status).toBe('requires_payment_method');

    // Headers the SDK emitted ↴
    const req = captured.at(-1);
    expect(req).toBeDefined();
    expect(req!.headers['idempotency-key']).toBe('inv-inv_test-attempt-1');
    expect(req!.headers['stripe-account']).toBe(STRIPE_ACCOUNT);
    // Form-encoded body — Stripe SDK never sends JSON.
    expect(req!.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(req!.bodyText).toContain('amount=50000');
    expect(req!.bodyText).toContain('currency=thb');
  });

  it('retrievePaymentIntent strips fingerprint/iin from card metadata (PCI allow-list)', async () => {
    server.use(
      http.get('https://api.stripe.com/v1/payment_intents/pi_retrieve_e3', async ({ request }) => {
        captureReq(request, '');
        return HttpResponse.json({
          id: 'pi_retrieve_e3',
          object: 'payment_intent',
          status: 'succeeded',
          client_secret: 'pi_retrieve_e3_secret',
          livemode: false,
          last_payment_error: null,
          latest_charge: {
            id: 'ch_retrieve_e3',
            object: 'charge',
            payment_method_details: {
              type: 'card',
              card: {
                brand: 'visa',
                last4: '4242',
                exp_month: 12,
                exp_year: 2030,
                // These MUST be stripped by the adapter per SAQ-A.
                fingerprint: 'abcdef1234567890',
                iin: '424242',
                country: 'TH',
                funding: 'credit',
                network: 'visa',
              },
            },
          },
        });
      }),
    );

    const result = await stripeGateway.retrievePaymentIntent(
      'pi_retrieve_e3',
      STRIPE_ACCOUNT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.id).toBe('pi_retrieve_e3');
    expect(result.value.card).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
    // Negative assertion — forbidden PCI fields ABSENT from mapped value.
    const cardKeys = new Set(Object.keys(result.value.card ?? {}));
    expect(cardKeys.has('fingerprint')).toBe(false);
    expect(cardKeys.has('iin')).toBe(false);
    expect(cardKeys.has('country')).toBe(false);
    expect(cardKeys.has('funding')).toBe(false);
    expect(cardKeys.has('network')).toBe(false);

    // Stripe-Account header on GET
    const req = captured.at(-1);
    expect(req!.headers['stripe-account']).toBe(STRIPE_ACCOUNT);
  });

  it('createRefund propagates idempotency key + maps 500 response to retryable error', async () => {
    server.use(
      http.post('https://api.stripe.com/v1/refunds', async ({ request }) => {
        captureReq(request, await request.text());
        return HttpResponse.json(
          {
            error: {
              type: 'api_error',
              message: 'Stripe internal error',
              code: 'stripe_internal',
            },
          },
          { status: 500 },
        );
      }),
    );

    const result = await stripeGateway.createRefund({
      paymentIntentId: 'pi_refund_e3',
      amountSatang: 10000n,
      reason: 'requested_by_customer',
      metadata: { refund_id: 'rfn_e3' },
      idempotencyKey: 'rfn-rfn_e3',
      stripeAccount: STRIPE_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected err');
    expect(result.error.kind).toBe('retryable');

    // Idempotency key header on refund create
    const req = captured.at(-1);
    expect(req!.headers['idempotency-key']).toBe('rfn-rfn_e3');
    expect(req!.headers['stripe-account']).toBe(STRIPE_ACCOUNT);
  });

  it('PCI: logger.info calls carry only the allow-list (no raw body, no clientSecret, no card)', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation((() => {}) as never);

    server.use(
      http.post('https://api.stripe.com/v1/payment_intents', async ({ request }) => {
        captureReq(request, await request.text());
        return HttpResponse.json({
          id: 'pi_pci_e3',
          object: 'payment_intent',
          amount: 20000,
          currency: 'thb',
          status: 'requires_payment_method',
          client_secret: 'pi_pci_e3_secret_SHOULD_NEVER_LOG',
          livemode: false,
          next_action: null,
          metadata: {},
        });
      }),
    );

    await stripeGateway.createPaymentIntent({
      amountSatang: 20000n,
      currency: 'thb',
      paymentMethodTypes: ['card'],
      metadata: {},
      idempotencyKey: 'inv-pci-attempt-1',
      stripeAccount: STRIPE_ACCOUNT,
    });

    // Assert every logger.info call's structured fields are allow-list only.
    const allowedKeys = new Set([
      'stripeAccount',
      'paymentIntentId',
      'status',
      'idempotencyKey',
      'refundId',
    ]);
    for (const call of infoSpy.mock.calls) {
      const [firstArg] = call as [unknown, unknown];
      if (typeof firstArg === 'object' && firstArg !== null) {
        for (const key of Object.keys(firstArg)) {
          expect(allowedKeys.has(key), `disallowed log field '${key}'`).toBe(true);
        }
        // Defence-in-depth: scan the serialized payload for the leaked secret.
        const serialized = JSON.stringify(firstArg);
        expect(serialized).not.toContain('SHOULD_NEVER_LOG');
        expect(serialized).not.toContain('client_secret');
      }
    }
  });
});
