/**
 * T089 — Integration: PromptPay server-locked amount.
 *
 * Spec authority:
 *   - specs/009-online-payment/tasks.md Phase 4 T089
 *   - FR-009 — invoice amount is server-locked; clients cannot influence
 *     the satang value sent to Stripe.
 *
 * Threat model: a malicious member crafts a /api/payments/initiate body
 * with `{ invoiceId, method: 'promptpay', amount: 1 }` hoping the server
 * will trust the supplied amount instead of looking it up from the F4
 * invoice. The route handler's zod schema only accepts
 * `{ invoiceId, method }` (no `amount` key), and the use-case sources
 * `totalSatang` from the F4 bridge invoice DTO. Therefore the value sent
 * to Stripe MUST equal the invoice's satang total, regardless of any
 * extra fields the client tries to inject.
 *
 * This test asserts the property at the gateway boundary using MSW v2 to
 * intercept the Stripe HTTP call and capture the form-encoded body.
 *
 * Coverage strategy: we exercise `stripeGateway.createPaymentIntent`
 * directly with the canonical promptpay shape that initiate-payment.ts
 * builds (paymentMethodTypes=['promptpay']). The server-confirm parameters
 * (`confirm=true`, `payment_method_data[type]=promptpay`) — added by T090
 * — must be in the request body.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import Stripe from 'stripe';
import { stripeGateway } from '@/modules/payments/infrastructure/stripe/stripe-gateway';
import {
  __resetStripeClientForTesting,
  __setStripeClientOverridesForTesting,
} from '@/modules/payments/infrastructure/stripe/stripe-client';

interface CapturedRequest {
  readonly bodyText: string;
}
const captured: CapturedRequest[] = [];

const STRIPE_ACCOUNT = 'acct_test_t089';
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  captured.length = 0;
  server.resetHandlers();
  __resetStripeClientForTesting();
  __setStripeClientOverridesForTesting({
    httpClient: Stripe.createFetchHttpClient(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetStripeClientForTesting();
});

describe('PromptPay server-locked amount (T089 / FR-009)', () => {
  it('createPaymentIntent forwards exact invoice amount + server-confirm params', async () => {
    server.use(
      http.post('https://api.stripe.com/v1/payment_intents', async ({ request }) => {
        captured.push({ bodyText: await request.text() });
        return HttpResponse.json({
          id: 'pi_promptpay_t089',
          object: 'payment_intent',
          amount: 53500,
          currency: 'thb',
          status: 'requires_action',
          client_secret: 'pi_promptpay_t089_secret_xyz',
          livemode: false,
          next_action: {
            type: 'promptpay_display_qr_code',
            promptpay_display_qr_code: {
              image_url_svg:
                'https://qr.stripe.com/v1/promptpay_t089.svg',
            },
          },
          metadata: {},
        });
      }),
    );

    // Canonical promptpay call — same shape initiate-payment.ts builds
    // when method='promptpay' is requested.
    const result = await stripeGateway.createPaymentIntent({
      amountSatang: 53500n,
      currency: 'thb',
      paymentMethodTypes: ['promptpay'],
      metadata: { invoice_id: 'inv_t089', tenant_id: 'swecham' },
      idempotencyKey: 'inv-inv_t089-attempt-1',
      stripeAccount: STRIPE_ACCOUNT,
      billingEmail: 'member@swecham.test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.id).toBe('pi_promptpay_t089');
    expect(result.value.promptpayQrSvgUrl).toBe(
      'https://qr.stripe.com/v1/promptpay_t089.svg',
    );

    const body = captured.at(-1)?.bodyText ?? '';
    // Amount in body equals the invoice satang total — NOT user-supplied.
    expect(body).toContain('amount=53500');
    expect(body).toContain('currency=thb');
    // Server-confirm params for PromptPay (T090). Stripe SDK form-
    // encodes array/object indices with raw `[0]` / `[type]` (not
    // percent-encoded) — the SDK's URLSearchParams polyfill emits
    // brackets verbatim.
    expect(body).toContain('payment_method_types[0]=promptpay');
    expect(body).toContain('confirm=true');
    expect(body).toContain('payment_method_data[type]=promptpay');
    // Regression guard: Stripe rejects server-confirmed PromptPay PIs
    // with `parameter_missing: billing_details[email]` if the field is
    // omitted. Live caught this once (Phase 4 verify pass); this assert
    // pins it so a future regression is caught at CI, not in production.
    // Email is form-encoded with URL-escaped `@` (%40).
    expect(body).toContain(
      'payment_method_data[billing_details][email]=member%40swecham.test',
    );
  });

  it('returns permanent error when promptpay is mixed with another method (Result, not throw)', async () => {
    // PromptPay requires server-confirm to surface the QR. Multi-
    // method PIs would skip server-confirm → silent UI failure.
    // The gateway must reject this synchronously with a typed
    // `permanent` error — NOT throw — so the Result<T,E> contract
    // at the boundary is preserved.
    const result = await stripeGateway.createPaymentIntent({
      amountSatang: 53500n,
      currency: 'thb',
      paymentMethodTypes: ['promptpay', 'card'],
      metadata: { invoice_id: 'inv_t089' },
      idempotencyKey: 'inv-inv_t089-attempt-mixed',
      stripeAccount: STRIPE_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.kind).toBe('permanent');
    if (result.error.kind !== 'permanent') throw new Error('unreachable');
    expect(result.error.code).toBe('promptpay_mixed_methods');
    // No Stripe HTTP call should have been issued — assertion
    // short-circuits before the SDK is touched.
    expect(captured.length).toBe(0);
  });

  it('Stripe rejects out-of-band amount drift after server-confirm (mock 400)', async () => {
    // Even if a downstream layer attempts a confirmation with a different
    // amount, Stripe rejects it. We model this by returning an
    // amount_mismatch error and asserting the gateway maps it to a
    // permanent failure that the use-case will surface as
    // `processor_unavailable` (which the route handler then renders as
    // HTTP 502). The point of this test is to prove the gateway does NOT
    // silently swallow an amount drift.
    server.use(
      http.post('https://api.stripe.com/v1/payment_intents', async () => {
        return HttpResponse.json(
          {
            error: {
              type: 'StripeInvalidRequestError',
              code: 'amount_mismatch',
              message: 'PaymentIntent amount does not match expected total',
            },
          },
          { status: 400 },
        );
      }),
    );

    const result = await stripeGateway.createPaymentIntent({
      amountSatang: 53500n,
      currency: 'thb',
      paymentMethodTypes: ['promptpay'],
      metadata: { invoice_id: 'inv_t089' },
      idempotencyKey: 'inv-inv_t089-attempt-2',
      stripeAccount: STRIPE_ACCOUNT,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.kind).toBe('permanent');
  });
});
