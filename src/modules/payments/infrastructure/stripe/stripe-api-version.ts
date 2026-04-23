/**
 * T037 — Stripe API version constant.
 *
 * Re-exports `env.stripe.apiVersion` as a strongly-typed const. The
 * webhook handler (`src/app/api/webhooks/stripe/route.ts`, Phase 3+)
 * writes this value into the `Stripe-Version` response header so
 * Stripe's replay-tools observe the same version the server used
 * when reading the event payload.
 *
 * Kept as its own tiny module so (a) the webhook route does NOT have
 * to import the full `stripe-client.ts` (which instantiates the SDK
 * at first call) just to learn the version string, and (b) future
 * tests that want to assert version pinning can import the const
 * without mocking the SDK.
 *
 * Pinning rationale: spec Q5 / FR-026. Quarterly engineering review
 * bumps the pin via an explicit PR with golden-fixture regeneration.
 *
 * Infrastructure-only per Constitution Principle III — NOT exported
 * from the module barrel.
 */
import { env } from '@/lib/env';

/**
 * Pinned Stripe API version. Source of truth = `STRIPE_API_VERSION`
 * env var (zod-validated at boot). Current value: `2025-09-30.clover`
 * (verified against Stripe CLI `stripe listen` output 2026-04-23).
 */
export const STRIPE_API_VERSION: string = env.stripe.apiVersion;
