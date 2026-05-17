/**
 * T-05 session revocation E2E (security.md § 3 row T-05, FR-011,
 * spec User Story 4).
 *
 * Asserts the full browser-level chain: when an admin disables a
 * user account, the target user's active browser tab becomes
 * invalid on the NEXT request (no in-place push; the check lives in
 * `getCurrentSession()` and fires when the protected layout re-runs
 * its guard).
 *
 * Integration-layer proof of the same guarantee lives in
 * `tests/integration/auth/account-lifecycle.test.ts`, but that
 * exercises the repo directly and cannot observe the browser
 * redirect. This spec closes the gap cited in the verify gate:
 * "when an admin disables a user in the browser, is the user
 * actually kicked out on their next click?".
 *
 * Requires TWO seeded test users: e2e-admin (admin role) and
 * e2e-member (member role). Run `scripts/seed-e2e-user.ts` first.
 */
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = 'e2e-admin@swecham.test';
const ADMIN_PASSWORD = 'E2E-Testing-Password-2026!xZ';
const VICTIM_EMAIL = 'e2e-member@swecham.test';
const VICTIM_PASSWORD = 'E2E-Testing-Password-2026!xZ';

test.describe.configure({ mode: 'serial' });

test.describe('session revocation on disable (T-05, User Story 4)', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  // Bump timeout — this spec runs TWO parallel sign-ins (victim +
  // admin) in separate contexts, then does a disable POST and a
  // victim redirect. The default 30s is tight when the dev server
  // is cold or Neon is slow. 60s gives breathing room without
  // hiding a real regression.
  test.setTimeout(60_000);

  test('disabled user is redirected to sign-in on next protected request', async ({
    browser,
  }) => {
    // Two fresh contexts so each user has an independent cookie jar.
    const adminCtx = await browser.newContext();
    const victimCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const victimPage = await victimCtx.newPage();

    try {
      // 1. Victim signs in to the member portal and lands on /portal.
      await victimPage.goto('/portal/sign-in');
      await victimPage.waitForLoadState('networkidle');
      await fillField(victimPage.getByLabel(/email/i), VICTIM_EMAIL);
      await fillField(victimPage.getByRole('textbox', { name: /^password$/i }), VICTIM_PASSWORD);
      await victimPage.getByRole('button', { name: /sign in/i }).click();
      await victimPage.waitForURL('**/portal', { timeout: 15_000 });
      await expect(victimPage).toHaveURL(/\/portal$/);

      // 2. Admin signs in (separate context) and opens the users list.
      await adminPage.goto('/admin/sign-in');
      await adminPage.waitForLoadState('networkidle');
      await fillField(adminPage.getByLabel(/email/i), ADMIN_EMAIL);
      await fillField(adminPage.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD);
      await adminPage.getByRole('button', { name: /sign in/i }).click();
      await adminPage.waitForURL('**/admin', { timeout: 15_000 });
      await adminPage.goto('/admin/users');
      await adminPage.waitForLoadState('networkidle');

      // 3. Admin disables the victim via the /api/auth/users/[id]/disable
      //    endpoint. We fire this via `adminPage.request` so the admin
      //    session cookie travels with the request (top-level request
      //    fixture has its own empty jar — see manager-read-only.spec.ts
      //    for the same gotcha). We don't use the UI button because it
      //    requires knowing the victim's user id at the DOM level, and
      //    the Playwright cookie path is simpler + faster.
      //
      //    First we need the victim's user id. Scrape it from the
      //    row in /admin/users — the row has `data-user-id` attrs.
      const victimRow = adminPage.locator(
        `[data-user-email="${VICTIM_EMAIL.toLowerCase()}"]`,
      );
      await expect(victimRow).toBeVisible({ timeout: 10_000 });
      const victimId = await victimRow.getAttribute('data-user-id');
      if (!victimId) throw new Error('victim row missing data-user-id');

      const pageUrl = new URL(adminPage.url());
      const origin = `${pageUrl.protocol}//${pageUrl.host}`;
      const disableResponse = await adminPage.request.post(
        `/api/auth/users/${victimId}/disable`,
        {
          headers: { 'Content-Type': 'application/json', Origin: origin },
          data: {},
        },
      );
      expect(disableResponse.status()).toBe(200);

      // 4. Victim's next navigation MUST redirect to /portal/sign-in.
      //    `getCurrentSession()` sees status != 'active' and deletes
      //    the session row; the layout guard then redirects.
      await victimPage.goto('/portal');
      await victimPage.waitForURL(/\/portal\/sign-in/, { timeout: 15_000 });
      await expect(victimPage).toHaveURL(/\/portal\/sign-in/);

      // 5. Cleanup: re-enable the victim so subsequent test runs
      //    and the seed-e2e-user.ts script have a clean baseline.
      const enableResponse = await adminPage.request.post(
        `/api/auth/users/${victimId}/enable`,
        {
          headers: { 'Content-Type': 'application/json', Origin: origin },
          data: {},
        },
      );
      expect(enableResponse.status()).toBe(200);
    } finally {
      await adminCtx.close();
      await victimCtx.close();
    }
  });
});
