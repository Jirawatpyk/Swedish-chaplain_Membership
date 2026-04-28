/**
 * T071 — Thin re-export of the Stripe webhook verifier singleton for the
 * route-handler layer.
 *
 * The concrete verifier lives at
 * `src/modules/payments/infrastructure/stripe/stripe-webhook-verifier.ts`.
 * This module sits in `src/lib/**` (the composition adapter layer) so the
 * webhook route `src/app/api/webhooks/stripe/route.ts` can import the
 * verifier without reaching into `@/modules/payments/infrastructure/**`
 * (which would trip the Clean-Architecture barrel guard — Principle III).
 *
 * Exported as `webhookVerifier` to match the Group B contract-test mocks
 * (`vi.mock('@/lib/stripe-webhook-verifier', () => ({ webhookVerifier: ... }))`).
 * The route must call `webhookVerifier.constructEvent(rawBody, sig, secret)`
 * which returns a `VerifiedStripeEvent` (narrow Application envelope) or
 * throws `WebhookSignatureError` with a `kind` discriminator.
 */
export { stripeWebhookVerifier as webhookVerifier } from '@/modules/payments/infrastructure/stripe/stripe-webhook-verifier';
export { WebhookSignatureError } from '@/modules/payments/infrastructure/stripe/errors';
export type { VerifiedStripeEvent } from '@/modules/payments/application/ports/webhook-verifier-port';
