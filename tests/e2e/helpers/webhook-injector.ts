/**
 * H-8 (review 2026-04-27) — Stripe webhook injector for E2E tests.
 *
 * Posts a signed Stripe webhook event to the local
 * `/api/webhooks/stripe` route handler so E2E tests can drive the
 * server-side state machine end-to-end without invoking the Stripe
 * dashboard or the live `stripe trigger` CLI.
 *
 * Two strategies are supported:
 *
 *   (a) Synthetic event (default) — build a minimal `Stripe.Event`
 *       payload in-process, sign with `generateTestHeaderString` using
 *       the same `STRIPE_WEBHOOK_SECRET` the server reads, POST via
 *       `fetch`. Deterministic, hermetic, no external process.
 *
 *   (b) `stripe trigger` CLI fallback — when the test needs the real
 *       Stripe-shape including computed fields (latest_charge, etc.)
 *       the caller can shell out to the Stripe CLI. Requires
 *       `stripe listen` running in another terminal.
 *
 * Strategy (a) is preferred for T121 because:
 *   - Tests run on developer laptops + CI without `stripe listen`
 *   - The server-side branch we're testing only inspects
 *     `event.type` + `event.data.object.id` + idempotency via
 *     `processor_events`; the synthetic payload is sufficient
 *   - Webhook signature verification is exercised by the same code
 *     path (constructEvent reads the same secret)
 *
 * PCI posture: synthetic event carries no PAN/CVV/track data — only
 * the PaymentIntent id + status (PCI-safe identifiers). Same posture
 * as `stripe trigger` events in test mode.
 */
import { request as playwrightRequest } from '@playwright/test';
import Stripe from 'stripe';

interface InjectWebhookInput {
  /** Webhook event type, e.g. 'payment_intent.succeeded'. */
  readonly type:
    | 'payment_intent.succeeded'
    | 'payment_intent.payment_failed'
    | 'payment_intent.canceled'
    | 'charge.refunded';
  /** PaymentIntent id (or charge id for charge.refunded events). */
  readonly objectId: string;
  /** Optional override fields merged into `event.data.object`. */
  readonly objectExtras?: Readonly<Record<string, unknown>>;
  /** Base URL of the dev server, defaults to env or localhost:3100. */
  readonly baseUrl?: string;
}

/**
 * Build a minimal signed Stripe webhook event + POST to
 * `/api/webhooks/stripe`. Returns the response so callers can assert
 * status code (200 ack vs 4xx reject).
 *
 * Reads `STRIPE_WEBHOOK_SECRET` from `process.env` — must match the
 * server-side env (same `.env.local` source). If absent, throws so
 * the test fails loudly rather than POSTing an unsigned payload that
 * the route would silently reject.
 */
export async function injectStripeWebhook(
  input: InjectWebhookInput,
): Promise<{ readonly status: number; readonly body: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      'injectStripeWebhook: STRIPE_WEBHOOK_SECRET not set — load .env.local before running E2E.',
    );
  }
  const baseUrl =
    input.baseUrl ??
    process.env.E2E_BASE_URL ??
    'http://localhost:3100';

  const eventId = `evt_e2e_${Math.random().toString(36).slice(2, 14)}`;
  const event = {
    id: eventId,
    object: 'event',
    api_version: process.env.STRIPE_API_VERSION ?? '2026-03-25.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    type: input.type,
    data: {
      object: {
        id: input.objectId,
        object: input.type.startsWith('charge.') ? 'charge' : 'payment_intent',
        ...(input.objectExtras ?? {}),
      },
    },
    request: { id: null, idempotency_key: null },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureHeader = Stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret,
    timestamp,
  });

  const ctx = await playwrightRequest.newContext();
  try {
    const response = await ctx.post(`${baseUrl}/api/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': signatureHeader,
      },
      data: rawBody,
    });
    return {
      status: response.status(),
      body: await response.text(),
    };
  } finally {
    await ctx.dispose();
  }
}
