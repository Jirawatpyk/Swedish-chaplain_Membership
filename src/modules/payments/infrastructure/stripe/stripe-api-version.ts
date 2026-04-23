/**
 * T037 — Stripe API version accessor.
 *
 * The webhook handler (`src/app/api/webhooks/stripe/route.ts`, Phase 3+)
 * writes this value into the `Stripe-Version` response header so
 * Stripe's replay-tools observe the same version the server used when
 * reading the event payload.
 *
 * Kept as a LAZY getter (not a module-level const) so importing this
 * module at build time — e.g. Next.js pre-rendering, or unit tests that
 * import route handlers without setting `STRIPE_*` env vars — does NOT
 * trigger `env.ts`'s zod parse. The getter reads env only on first call
 * at request time, matching the deferral pattern in `stripe-client.ts`.
 *
 * Pinning rationale: spec Q5 / FR-026. Quarterly engineering review
 * bumps the pin via an explicit PR with golden-fixture regeneration.
 *
 * Infrastructure-only per Constitution Principle III — NOT exported
 * from the module barrel.
 */
import { env } from '@/lib/env';

/**
 * Returns the pinned Stripe API version. Source of truth =
 * `STRIPE_API_VERSION` env var (zod-validated at boot). Current value:
 * `2025-09-30.clover` (verified against Stripe CLI `stripe listen`
 * output 2026-04-23).
 */
export function getStripeApiVersion(): string {
  return env.stripe.apiVersion;
}
