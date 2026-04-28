/**
 * T037 — Stripe API version accessor.
 *
 * The webhook handler (`src/app/api/webhooks/stripe/route.ts`, Phase 3+)
 * writes this value into the `Stripe-Version` response header so
 * Stripe's replay-tools observe the same version the server used when
 * reading the event payload.
 *
 * Exported as a getter (not a const) so tests that mock `@/lib/env` can
 * shape the return value per-case. The env parse itself still runs at
 * the first import of `@/lib/env` transitively — true build-time
 * deferral would require a dynamic `await import()`, which would force
 * the getter to be async and propagate awaits into every call site.
 * Not worth the ergonomic cost.
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
