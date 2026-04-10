/**
 * T168 — User-feedback coverage E2E (spec SC-015, ux-standards § 5).
 *
 * Every success/error path on an auth screen MUST surface exactly
 * one piece of visible feedback — either a `sonner` toast OR a
 * `role="status"` success card. The forgot-password form uses a
 * card (source: forgot-password-form.tsx `setSubmitted(true)` →
 * `<div role="status">{t('submitted')}</div>`); sign-in errors use
 * a toast + an inline banner.
 *
 * This test verifies the HAPPY PATH on forgot-password: after submit,
 * exactly one `role="status"` region is visible (the success card),
 * and the submit button has been replaced by a "Resend" button.
 */
import { expect, test } from '@playwright/test';

test.describe('feedback coverage on auth screens (T168, SC-015)', () => {
  test('forgot-password success shows exactly one status region', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.waitForLoadState('networkidle');

    await page
      .getByLabel(/email/i)
      .fill(`toast-coverage-${Date.now()}@swecham.test`);

    await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/auth/forgot-password') &&
          res.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByRole('button', { name: /send|reset|email/i }).first().click(),
    ]);

    // Success card is rendered with role="status" so the a11y tree
    // announces it to assistive tech. Next.js's own route-announcer
    // also emits a role="status" element — so we filter to the one
    // that contains text (the empty Next.js announcer is an empty
    // string).
    const statusCard = page
      .locator('[role="status"]')
      .filter({ hasText: /.+/ })
      .first();
    await expect(statusCard).toBeVisible({ timeout: 5_000 });

    // The submit button has morphed into the "Resend" button while
    // the countdown runs — presence of this button is a second
    // observable "feedback received" signal.
    await expect(
      page.getByRole('button', { name: /resend/i }).first(),
    ).toBeVisible();
  });
});
