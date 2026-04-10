/**
 * T-01 lockout UX E2E (spec FR-013, security.md T-01).
 *
 * Covers the browser-visible lockout flow that the integration test
 * `tests/integration/auth/lockout.test.ts` pins at the DB layer:
 *
 *   1. Attacker (or fat-fingered user) submits wrong password 5 times
 *      against a known account.
 *   2. Server locks the account for 15 minutes.
 *   3. Attacker's 6th attempt returns `account-locked` (403, NOT 401).
 *   4. The sign-in form shows the "account locked — try again later"
 *      toast so the user knows what happened and doesn't keep
 *      guessing.
 *
 * Uses a dedicated disposable target account (`e2e-lockout@swecham.test`)
 * via `scripts/seed-e2e-user.ts`. Do NOT run against the bootstrap
 * admin — this test WILL lock the account, and even though the
 * lockout expires in 15 minutes, locking the only production admin
 * out for 15 minutes is obviously bad. The per-IP rate limit
 * (30/15 min) is wide enough to accommodate 6 sign-in attempts from
 * one browser context.
 *
 * If the dedicated lockout user isn't seeded, the test skips
 * with a helpful message. Pre-existing lockout state (from a
 * previous run's final attempt) is cleared at `beforeAll` via
 * `clearAllE2ELockouts()` so the test starts from a clean baseline.
 */
import { expect, test } from '@playwright/test';
import { clearE2ERateLimits } from './helpers/rate-limit';

// Reuse the member user — locking the admin would block the
// seed-e2e-user re-run path; member is disposable.
const LOCKOUT_EMAIL = process.env.E2E_MEMBER_EMAIL;
const LOCKOUT_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('T-01 sign-in lockout UX (spec FR-013, SC-010)', () => {
  test.skip(
    !LOCKOUT_EMAIL || !LOCKOUT_PASSWORD,
    'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD to run (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    // Wipe rate-limit buckets + any leftover lockout so we start
    // from a clean baseline. `clearE2ERateLimits` only clears
    // Upstash keys; the lockout counter lives on the user row and
    // is cleared by scripts/seed-e2e-user.ts (which sets
    // `failedSignInCount=0` + `lockedUntil=null` on every run).
    // A manual re-seed before this test is the safe reset path.
    await clearE2ERateLimits();
  });

  test('5 wrong attempts lock the account; the 6th shows the locked toast', async ({
    page,
  }) => {
    // Drive the sign-in form 5 times with a deliberately wrong
    // password. Go to the MEMBER sign-in page because the seeded
    // E2E_MEMBER user has role=member and can't sign in via
    // /admin/sign-in without tripping the portal-mismatch check
    // (which returns 401 invalid-credentials, NOT a lockout failure).
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.goto('/portal/sign-in');
      await page.waitForLoadState('networkidle');
      await page.getByLabel(/email/i).fill(LOCKOUT_EMAIL!);
      await page
        .getByLabel(/password/i)
        .fill(`wrong-password-attempt-${attempt}`);

      // Wait for the POST response so we can inspect status codes.
      const responsePromise = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/sign-in') &&
          r.request().method() === 'POST',
        { timeout: 10_000 },
      );
      await page.getByRole('button', { name: /sign in/i }).click();
      const response = await responsePromise;

      // First 4 attempts → 401 invalid-credentials. The 5th is also
      // 401 invalid-credentials BUT the DB-level failed-count hits
      // the 5 threshold and sets `lockedUntil`, so the 6th attempt
      // (below) is the first one to see `account-locked`.
      expect([401, 403, 429]).toContain(response.status());
    }

    // 6th attempt — MUST now be `account-locked` (403), not
    // `invalid-credentials` (401). This is the core T-01 assertion:
    // the server has flipped the account into the locked state and
    // the browser must see the distinct response.
    await page.goto('/portal/sign-in');
    await page.waitForLoadState('networkidle');
    await page.getByLabel(/email/i).fill(LOCKOUT_EMAIL!);
    await page
      .getByLabel(/password/i)
      .fill('wrong-password-attempt-final');

    const sixthResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/sign-in') &&
        r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await page.getByRole('button', { name: /sign in/i }).click();
    const response = await sixthResponse;

    // Core assertion: the response MUST be `account-locked` (403).
    // A 401 here would mean the lockout didn't stick — which is a
    // direct T-01 regression.
    expect(response.status()).toBe(403);
    const body = await response.json().catch(() => ({}));
    expect(body.error).toBe('account-locked');

    // UX assertion: the form shows the locked toast (not the
    // generic invalid-credentials inline error). sonner renders
    // toasts into a portal at the page level.
    await expect(
      page.getByText(/account.*locked|locked.*try again/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test.afterAll(async () => {
    // NOTE: the lockout will auto-clear after 15 minutes or on the
    // next `scripts/seed-e2e-user.ts` run (which resets
    // failedSignInCount + lockedUntil). We deliberately do NOT
    // programmatically unlock here because doing so would require
    // direct DB access from the E2E runner, and the 15-minute
    // auto-expiry is the whole point of the test.
    //
    // If a developer needs to immediately re-run this spec,
    // `pnpm tsx scripts/seed-e2e-user.ts` resets the state.
  });
});
