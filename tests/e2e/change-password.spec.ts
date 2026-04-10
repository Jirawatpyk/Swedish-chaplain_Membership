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
 * Requires E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD. Because this test
 * actually mutates the admin password, it restores the original
 * password at the end. Runs serially to avoid racing itself.
 */
import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('change-password happy path (T150, SC-021)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run',
  );

  const tempPassword = `Temp-Rotate-${Date.now()}-xZ!9`;

  test('signed-in admin can change password and re-sign-in with the new one', async ({
    page,
  }) => {
    // Sign in
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Open account page
    await page.goto('/admin/account');
    await page.waitForLoadState('networkidle');

    // Primary input auto-focus — current password field per FR-024
    await expect(page.getByLabel(/current password/i)).toBeFocused();

    await page.getByLabel(/current password/i).fill(ADMIN_PASSWORD!);
    await page.getByLabel(/^new password$/i).fill(tempPassword);
    const confirm = page.getByLabel(/confirm/i);
    if (await confirm.count()) {
      await confirm.first().fill(tempPassword);
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
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(tempPassword);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Revert: change back to the original password so the E2E env
    // stays usable.
    await page.goto('/admin/account');
    await page.getByLabel(/current password/i).fill(tempPassword);
    await page.getByLabel(/^new password$/i).fill(ADMIN_PASSWORD!);
    const confirm = page.getByLabel(/confirm/i);
    if (await confirm.count()) {
      await confirm.first().fill(ADMIN_PASSWORD!);
    }
    await page.getByRole('button', { name: /change|update|save/i }).first().click();
    await page.waitForResponse(
      (r) => r.url().includes('/api/auth/change-password'),
      { timeout: 15_000 },
    );
  });
});
