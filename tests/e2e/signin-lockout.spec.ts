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
 * Uses a **DEDICATED** disposable target account
 * (`e2e-lockout@swecham.test`) provisioned by
 * `scripts/seed-e2e-user.ts`. This account is used by NO other spec
 * — locking it does not pollute any sibling E2E's sign-in path.
 * Re-running the seed script resets `failedSignInCount=0` +
 * `lockedUntil=null` so this spec can be re-run immediately.
 *
 * Skipped automatically if `E2E_LOCKOUT_EMAIL` is unset. Re-seed
 * the E2E users before running this spec:
 *
 *     node --env-file=.env.local --import tsx scripts/seed-e2e-user.ts
 *     E2E_LOCKOUT_EMAIL='e2e-lockout@swecham.test' \
 *       E2E_LOCKOUT_PASSWORD='E2E-Testing-Password-2026!xZ' \
 *       pnpm test:e2e tests/e2e/signin-lockout.spec.ts
 */
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const LOCKOUT_EMAIL = process.env.E2E_LOCKOUT_EMAIL;
const LOCKOUT_PASSWORD = process.env.E2E_LOCKOUT_PASSWORD;

test.describe.configure({ mode: 'serial' });

// Only run on the `chromium` project (desktop Chrome). Playwright
// runs every spec once per project (`chromium`, `mobile-safari`,
// `mobile-chrome`) in parallel. Because the lockout counter lives
// on a SHARED Neon row, running this spec on 3 projects
// simultaneously creates a race: each project submits 5 wrong
// passwords + 1 locked check, but the row hits `failedSignInCount=5`
// on whichever project writes first — the others see the lockout
// on their 2nd or 3rd attempt and fail the assertion. Also, 3 × 6
// = 18 attempts blow through the per-IP rate limit (30/15 min)
// shared across the browser suite, starving every other sign-in
// test. The check runs at module-load time (when `test.describe`
// is declared) using `process.env.PLAYWRIGHT_PROJECT` — Playwright
// sets neither that nor a dependable alternative, so we instead
// guard the whole `test.describe` with a runtime annotation on
// each test via `test.skip(...)` inside the test body itself.
test.describe('T-01 sign-in lockout UX (spec FR-013, SC-010)', () => {
  test.skip(
    !LOCKOUT_EMAIL || !LOCKOUT_PASSWORD,
    'Set E2E_LOCKOUT_EMAIL + E2E_LOCKOUT_PASSWORD to run (seeded by scripts/seed-e2e-user.ts — a dedicated disposable account)',
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
  }, testInfo) => {
    // Chromium-project-only — see rationale at top of file.
    test.skip(
      testInfo.project.name !== 'chromium',
      'lockout spec is chromium-project-only — the DB lockout row is shared across browser projects; running it 3x creates a race and exhausts per-IP rate limits',
    );

    // Important flow detail (sign-in.ts):
    //   1. Rate-limit check first  → 429 if per-email bucket full (5/15 min)
    //   2. User lookup
    //   3. Password verify → on miss, increment `failedSignInCount`
    //   4. If count ≥ 5, set `lockedUntil = now + 15 min`
    //
    // After 5 wrong attempts the per-email BUCKET is full AND the
    // account is locked. A naive 6th attempt would hit the 429
    // branch first (rate-limit) and never reach step 4's locked
    // check. In production this is fine — the user sees
    // rate-limited, waits 15 min, then sees account-locked.
    // Simulating 15 min in an E2E is impractical, so we instead
    // clear the Upstash rate-limit bucket AFTER the 5th attempt
    // (which does NOT clear the DB lockout row — the row stays
    // locked via `lockedUntil` for the full 15 min) so the 6th
    // attempt reaches step 4 and returns 403 account-locked.
    //
    // The member sign-in page is used because the seeded lockout
    // account has role=member — admin page would return
    // portal-mismatch 401 instead of lockout 403.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await page.goto('/portal/sign-in');
      await page.waitForLoadState('networkidle');
      await fillField(page.getByLabel(/email/i), LOCKOUT_EMAIL!);
      await fillField(
        page.getByRole('textbox', { name: /^password$/i }),
        `wrong-password-attempt-${attempt}`,
      );

      const responsePromise = page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/sign-in') &&
          r.request().method() === 'POST',
        { timeout: 10_000 },
      );
      await page.getByRole('button', { name: /sign in/i }).click();
      const response = await responsePromise;

      // Attempts 1-5 should all return 401 invalid-credentials.
      // 429 means a previous run didn't clear Upstash properly.
      expect([401, 403]).toContain(response.status());
    }

    // Simulate 15 minutes passing: clear the Upstash per-email
    // rate-limit bucket so the 6th attempt can reach the lockout
    // check. The DB `lockedUntil` row stays in the future — this
    // is the state the user would be in after waiting out the
    // rate limit.
    await clearE2ERateLimits();

    // 6th attempt — MUST now be `account-locked` (403).
    await page.goto('/portal/sign-in');
    await page.waitForLoadState('networkidle');
    await fillField(page.getByLabel(/email/i), LOCKOUT_EMAIL!);
    await fillField(
      page.getByRole('textbox', { name: /^password$/i }),
      'wrong-password-attempt-final',
    );

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

    // UX assertion: the form shows the "too many failed attempts"
    // message from `auth.signIn.errors.accountLocked`. Since PR #133
    // all server rejections (account-locked included) render in the
    // inline #signin-error banner (role="alert"), not a sonner toast.
    // The EN copy is "Too many failed attempts. Try again later.";
    // Thai and Swedish use their translations.
    // Scope to the inline #signin-error banner (not just "visible somewhere")
    // so the test actually enforces the inline-banner-not-toast contract.
    await expect(page.locator('#signin-error')).toContainText(
      /too many failed attempts|try again later/i,
      { timeout: 5_000 },
    );
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
