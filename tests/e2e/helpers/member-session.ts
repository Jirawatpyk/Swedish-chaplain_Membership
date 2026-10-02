/**
 * T082 — Shared auth helper + `memberTest` fixture for the F5 pay-sheet
 * E2E suites.
 *
 * Background: the 74 pay-sheet tests (63 viewport + 11 happy-path)
 * were authored as `test.fixme()`-gated scaffolding in Phase 3 pending
 * a member-session bootstrap. Rather than inline the sign-in dance in
 * every spec, this helper exposes:
 *
 *   - `signInAsMember(page)` — navigates to `/portal/sign-in`, fills
 *     the E2E member credentials, awaits the `/portal` redirect.
 *     Fails loud if `E2E_MEMBER_EMAIL` / `E2E_MEMBER_PASSWORD` are
 *     unset (caller should have gated the suite with `test.fixme`).
 *
 *   - `memberTest` — a Playwright fixture that auto-signs the member
 *     in before every test body. Extends `./fixtures.ts` so the
 *     `autoClearRateLimits` auto-fixture still fires first (the
 *     rate-limit bucket must be cleared BEFORE the sign-in or the
 *     5/15-minute bucket trips mid-suite).
 *
 * Fixture ordering:
 *   1. `autoClearRateLimits` (from ./fixtures.ts) — clears Upstash
 *      buckets for all 4 E2E accounts.
 *   2. `page` override below — signs the member in on a fresh page.
 *   3. test body — starts on `/portal` with a valid session cookie.
 *
 * Why one-time-login-per-spec (not `storageState` reuse):
 *   - Our sign-in endpoint sets an HttpOnly session cookie bound to
 *     the originating User-Agent + IP fingerprint. Playwright's
 *     `storageState` can carry cookies across tests, but the session
 *     row in Postgres has a 30-min idle TTL and our integration-test
 *     cache purge (`scripts/clear-rate-limit.ts` + rate-limit auto-
 *     fixture) also invalidates stale sessions. Re-signing per test
 *     is ~400 ms overhead vs. debugging ghost-session flakes.
 *   - Across the 3 Playwright projects (chromium / mobile-safari /
 *     mobile-chrome) the UA changes, so a shared storageState would
 *     break UA-binding invariants. Per-test sign-in sidesteps this.
 *
 * Consumers:
 *   - tests/e2e/pay-sheet-viewport.spec.ts (63 tests)
 *   - tests/e2e/payment-card-happy-path.spec.ts (11 tests)
 *
 * Import pattern — mirror `fixtures.ts`:
 *
 *     import { memberTest as test, expect } from './helpers/member-session';
 *
 *     test('my spec', async ({ page }) => {
 *       // page already signed in as e2e-member@swecham.test on /portal
 *     });
 */
import type { Page } from '@playwright/test';
import { test as baseTest, expect } from '../fixtures';
import { fillField } from '../fixtures';
import { signInLandingSettled } from './sign-in-landing';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { expect };

export interface MemberCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * The `e2e-member-empty` persona (E2E_MEMBER_EMAIL_EMPTY / _PASSWORD_EMPTY),
 * or null when unset. Use it for any page a LAPSED member cannot reach: the
 * F8 renewals seed (`renewals-seed.ts`, global setup) always lapses the
 * default `e2e-member`, and the portal sends a lapsed member from
 * non-allowlisted routes back to /portal. Overriding E2E_MEMBER_EMAIL does
 * not work — the seed follows that variable and lapses the override too.
 */
export function goodStandingMemberCredentials(): MemberCredentials | null {
  const email = process.env.E2E_MEMBER_EMAIL_EMPTY;
  const password = process.env.E2E_MEMBER_PASSWORD_EMPTY;
  return email && password ? { email, password } : null;
}

/**
 * Sign the E2E member fixture in. Uses `fillField` so the WebKit
 * email-input quirk (see fixtures.ts) is handled transparently.
 *
 * Throws (via Playwright assertion) if the /portal redirect does not
 * complete within 30 s — surfaces dev-server cold-compile stalls
 * cleanly instead of cascading into "sheet not visible" timeouts
 * further down the test.
 */
export async function signInAsMember(
  page: Page,
  credentials?: MemberCredentials,
): Promise<void> {
  const email = credentials?.email ?? process.env.E2E_MEMBER_EMAIL;
  const password = credentials?.password ?? process.env.E2E_MEMBER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsMember: E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD must be set in .env.local. ' +
        'Run `pnpm tsx scripts/seed-e2e-user.ts` and re-pull env vars.',
    );
  }

  await page.goto('/portal/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  // R9.B1 / F1 PasswordInput regression — see admin-session.ts for
  // full rationale. The older `getByLabel` pattern resolved to BOTH
  // the password input AND the "Show password" toggle button.
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  // See sign-in-landing.ts — WebKit fails the next goto without this.
  const landingSettled = signInLandingSettled(page, '/portal/sign-in');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/portal', { timeout: 30_000 });
  await landingSettled;
}

/**
 * Playwright fixture that signs the E2E member in before every test.
 * Use as a drop-in replacement for `test` from `./fixtures`.
 */
export const memberTest = baseTest.extend({
  // Rename the Playwright fixture-consumer callback from the default
  // `use` to `runTest` so eslint-plugin-react-hooks does not
  // misclassify it as a React hook. Playwright's API accepts any
  // parameter name here.
  page: async ({ page }, runTest) => {
    await signInAsMember(page);
    await runTest(page);
  },
});

/**
 * The same fixture, signed in as the GOOD-STANDING persona. Use it for a route
 * the lapsed scope does not allow: there `requireMemberContext` answers
 * `403 membership_access_restricted` before the code under test runs, so a spec
 * on `memberTest` ends up asserting against the gate instead of its subject.
 *
 * It throws rather than falling back to the default persona when the `_EMPTY`
 * vars are unset. A silent fallback would put the spec back on the lapsed
 * member and let it pass or fail for the wrong reason, which is the whole bug
 * this fixture exists to avoid. Pair it with a
 * `test.skip(!goodStandingMemberCredentials(), …)` in the spec so a machine
 * without the fixtures skips loudly instead of erroring.
 */
export const goodStandingMemberTest = baseTest.extend({
  page: async ({ page }, runTest) => {
    const credentials = goodStandingMemberCredentials();
    if (!credentials) {
      throw new Error(
        'goodStandingMemberTest: E2E_MEMBER_EMAIL_EMPTY / E2E_MEMBER_PASSWORD_EMPTY must be set. ' +
          'Run `pnpm tsx scripts/seed-e2e-portal-invoices.ts` and re-pull env vars.',
      );
    }
    await signInAsMember(page, credentials);
    await runTest(page);
  },
});
