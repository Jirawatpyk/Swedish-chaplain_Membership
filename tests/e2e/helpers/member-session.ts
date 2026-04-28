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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { expect };

/**
 * Sign the E2E member fixture in. Uses `fillField` so the WebKit
 * email-input quirk (see fixtures.ts) is handled transparently.
 *
 * Throws (via Playwright assertion) if the /portal redirect does not
 * complete within 30 s — surfaces dev-server cold-compile stalls
 * cleanly instead of cascading into "sheet not visible" timeouts
 * further down the test.
 */
export async function signInAsMember(page: Page): Promise<void> {
  const email = process.env.E2E_MEMBER_EMAIL;
  const password = process.env.E2E_MEMBER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsMember: E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD must be set in .env.local. ' +
        'Run `pnpm tsx scripts/seed-e2e-user.ts` and re-pull env vars.',
    );
  }

  await page.goto('/portal/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByLabel(/password/i), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/portal', { timeout: 30_000 });
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
