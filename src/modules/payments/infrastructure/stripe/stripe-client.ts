/**
 * T036 — Stripe SDK module-level singleton.
 *
 * Single `Stripe` instance shared by every F5 call site (payment intent
 * creation, refund, retrieve, webhook signature verification). Re-
 * instantiating per request would be wasteful (Stripe's Node SDK
 * maintains an internal keep-alive HTTPS agent + rate-limit-retry
 * state) and would scatter API-version configuration across call sites.
 *
 * Initialisation is deferred via a lazy getter so importing this module
 * at build time (`next build` pre-rendering) does NOT run the Stripe
 * constructor or require env values. The first `getStripeClient()`
 * call on the server resolves `env.stripe.*` and memoises the instance.
 *
 * PCI posture: the secret key comes from env (Constitution Principle IV).
 * Logger's REDACT_PATHS (T032) blocks accidental secret leakage into
 * logs; this module never logs the secret itself.
 *
 * API version pinning: the server SDK uses `env.stripe.apiVersion`
 * which is the same value surfaced by the webhook handler in its
 * `Stripe-Version` response header (T037). Both sides see the same
 * API version — Q5 / FR-026 compliance.
 *
 * Infrastructure-only per Constitution Principle III — NOT exported
 * from `src/modules/payments/index.ts`.
 */
import Stripe from 'stripe';
import { env } from '@/lib/env';

/**
 * Public contract that F5 use-cases depend on. Narrowed subset of
 * `Stripe` — only the methods we actually call at the Application
 * layer. Keeping this interface small makes mocking in unit tests
 * predictable (Application ports won't accidentally couple to random
 * Stripe SDK surface area).
 */
export interface StripeClient {
  readonly paymentIntents: Stripe['paymentIntents'];
  readonly refunds: Stripe['refunds'];
  readonly charges: Stripe['charges'];
  readonly webhooks: Stripe['webhooks'];
  readonly accounts: Stripe['accounts'];
}

let _instance: Stripe | null = null;

/**
 * Lazily create + memoise the Stripe client on first call. Safe to
 * call from any server-side code; returns the same instance every
 * time. Webhook + server actions + cron handlers all share the
 * instance.
 *
 * `apiVersion` type note: the Stripe SDK v22 constructor's
 * `StripeConfig.apiVersion` field is typed to the literal SDK-pinned
 * version (`'2026-03-25.dahlia'`). We DELIBERATELY pin an older
 * version (`2025-09-30.clover` — see research.md § 2) so the server
 * and Stripe CLI / Dashboard observe the same event shape. The cast
 * through `as unknown as Stripe.LatestApiVersion` acknowledges this
 * type drift; response-shape drift is accepted per spec Q5 / FR-026
 * quarterly review. If the pinned version ever falls >2 quarters
 * behind, regenerate golden fixtures + bump STRIPE_API_VERSION in
 * an explicit PR.
 */
export function getStripeClient(): StripeClient {
  if (_instance === null) {
    _instance = new Stripe(env.stripe.secretKey, {
      // `apiVersion` is narrowly typed to the SDK's built-in literal;
      // double cast `unknown → literal type` to accept the runtime-
      // pinned version while keeping the rest of the config type-checked.
      apiVersion: env.stripe.apiVersion as unknown as '2026-03-25.dahlia',
      // Explicit typescript=true locks inferred response types to
      // Stripe's shipped .d.ts (defaults to true on SDK v22 but
      // worth documenting). No effect at runtime.
      typescript: true,
      // App identifier surfaces in Stripe Dashboard → Logs as the
      // "Integration" column — makes production-side debugging
      // easier when multiple tenants share the same Stripe account.
      appInfo: {
        name: 'Chamber-OS',
        version: '0.1.0',
        url: 'https://swecham.zyncdata.app',
      },
    });
  }
  return _instance;
}

/**
 * Test-only: reset the memoised instance. Used by unit tests that
 * need to re-initialise with a different env setup between cases.
 * NO production code should call this.
 */
export function __resetStripeClientForTesting(): void {
  _instance = null;
}
