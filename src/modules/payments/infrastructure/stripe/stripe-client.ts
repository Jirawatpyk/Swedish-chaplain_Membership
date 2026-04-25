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
 * Test-only override for the Stripe SDK constructor options. When set,
 * the next `getStripeClient()` call uses these overrides INSTEAD of
 * the default config. Cleared by `__resetStripeClientForTesting()`.
 *
 * Audit 2026-04-25: introduced so the MSW-mocked integration test
 * (`tests/integration/payments/stripe-gateway-mock.test.ts`) can
 * inject `httpClient: Stripe.createFetchHttpClient()`. Stripe SDK
 * v22's default Node https client + keep-alive pool doesn't reliably
 * round-trip through MSW v2's ClientRequest interceptor on Node 20;
 * fetch-based client + MSW intercepts cleanly. Production code
 * NEVER calls this — only tests do.
 */
let _testOverrides: Partial<NonNullable<ConstructorParameters<typeof Stripe>[1]>> | null = null;

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
    const baseConfig: NonNullable<ConstructorParameters<typeof Stripe>[1]> = {
      apiVersion: env.stripe.apiVersion as unknown as '2026-03-25.dahlia',
      typescript: true,
      // Bounded SDK resilience — prevents an unbounded Stripe API hang
      // (observed during SG→US latency spikes) from blocking webhook
      // handlers past the Vercel function timeout. These apply PER
      // REQUEST: worst case ~30s (1 × timeout + 3 retries × ~7s backoff)
      // for a single SDK call. A webhook that chains N SDK calls
      // (retrieve + refund + reconcile) gets ~30s × N, so keep chained
      // calls to ≤3 inside one function invocation (Vercel default
      // 300s) or split across a queue.
      maxNetworkRetries: 3,
      timeout: 10_000,
      appInfo: {
        name: 'Chamber-OS',
        version: '0.1.0',
        url: 'https://swecham.zyncdata.app',
      },
    };
    _instance = new Stripe(env.stripe.secretKey, {
      ...baseConfig,
      ...(_testOverrides ?? {}),
    });
  }
  return _instance;
}

/**
 * Test-only: reset the memoised instance + clear any overrides. Used
 * by unit tests that need to re-initialise with a different env setup
 * between cases. NO production code should call this.
 */
export function __resetStripeClientForTesting(): void {
  _instance = null;
  _testOverrides = null;
}

/**
 * Test-only: install Stripe SDK constructor overrides (e.g.
 * `httpClient: Stripe.createFetchHttpClient()` for MSW interception).
 * Call BEFORE the first `getStripeClient()` call in the test (or
 * after `__resetStripeClientForTesting()` to take effect on the next
 * call). Audit 2026-04-25 — see `_testOverrides` JSDoc above.
 */
export function __setStripeClientOverridesForTesting(
  overrides: Partial<NonNullable<ConstructorParameters<typeof Stripe>[1]>>,
): void {
  _testOverrides = overrides;
}
