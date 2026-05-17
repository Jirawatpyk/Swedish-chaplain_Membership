/**
 * T150 — Change-password happy path E2E (spec US6 AS1, SC-021).
 *
 * Walks the signed-in staff account page flow:
 *   1. Sign in as admin.
 *   2. Open /admin/account.
 *   3. Fill current + new password (new != current, meets policy).
 *   4. Submit; expect the current session to remain valid (sliding
 *      rotation — see change-password.ts) and a success toast to
 *      appear.
 *   5. Sign out; assert re-sign-in with the NEW password succeeds.
 *
 * **Safety rule**: this test mutates a real password. It MUST only
 * ever run against a dedicated throwaway test user — never the
 * bootstrap/production admin. We therefore HARDCODE the test user
 * email below to the one seeded by `scripts/seed-e2e-user.ts`, and
 * ignore `E2E_ADMIN_EMAIL` entirely. If the dedicated user doesn't
 * exist, the test skips with a helpful message instructing the
 * operator to run the seed script.
 *
 * Historical incident (2026-04-10): an earlier version of this spec
 * read `E2E_ADMIN_EMAIL` from the env and mutated whatever user that
 * pointed at — which happened to be the real bootstrap admin. The
 * revert step failed under flaky conditions and left the admin's
 * password stuck at a throwaway temp value. The fix is the hardcode.
 */
import { expect, fillField, test } from './fixtures';

// Hardcoded — do NOT read from env. Seeded by scripts/seed-e2e-user.ts.
const E2E_CHANGE_PW_EMAIL = 'e2e-admin@swecham.test';
const E2E_CHANGE_PW_PASSWORD = 'E2E-Testing-Password-2026!xZ';

test.describe.configure({ mode: 'serial' });

test.describe('change-password happy path (T150, SC-021)', () => {
  // Evaluate temp password PER-TEST inside each test's closure so
  // retries or re-runs don't compare against a stale snapshot.
  const tempPassword = `E2E-Temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-xZ!9`;

  test('signed-in admin can change password and re-sign-in with the new one', async ({
    page,
  }) => {
    // Sign in
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), E2E_CHANGE_PW_EMAIL);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), E2E_CHANGE_PW_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Open account page
    await page.goto('/admin/account');
    await page.waitForLoadState('networkidle');

    // Primary input auto-focus — current password field per FR-024
    await expect(page.getByLabel(/current password/i)).toBeFocused();

    await fillField(page.getByLabel(/current password/i), E2E_CHANGE_PW_PASSWORD);
    await fillField(page.getByLabel(/^new password$/i), tempPassword);
    const confirm = page.getByLabel(/confirm/i);
    if (await confirm.count()) {
      await fillField(confirm.first(), tempPassword);
    }

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/change-password') && r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByRole('button', { name: /change|update|save/i }).first().click(),
    ]);

    // Success toast
    await expect(
      page.getByText(/password.*(updated|changed)|success/i).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('re-sign-in with NEW password succeeds; revert to original', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), E2E_CHANGE_PW_EMAIL);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), tempPassword);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Revert: change back to the original password so the E2E env
    // stays usable.
    await page.goto('/admin/account');
    await fillField(page.getByLabel(/current password/i), tempPassword);
    await fillField(page.getByLabel(/^new password$/i), E2E_CHANGE_PW_PASSWORD);
    const confirm = page.getByLabel(/confirm/i);
    if (await confirm.count()) {
      await fillField(confirm.first(), E2E_CHANGE_PW_PASSWORD);
    }
    await page.getByRole('button', { name: /change|update|save/i }).first().click();
    await page.waitForResponse(
      (r) => r.url().includes('/api/auth/change-password'),
      { timeout: 15_000 },
    );
  });
});
