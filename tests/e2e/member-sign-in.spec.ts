/**
 * T140 — Member sign-in E2E (spec US5 AS1, FR-002).
 *
 * Walks the public member sign-in flow:
 *   1. Land on /portal/sign-in (email auto-focused).
 *   2. Sign in with member credentials.
 *   3. Land on /portal with the placeholder "Welcome" page.
 *   4. Attempt to hit /admin → redirected back to /portal (cross-
 *      portal defence).
 *
 * Skips unless E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD are set.
 */
import { expect, test } from '@playwright/test';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('member sign-in (T140)', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD to run',
  );

  test('member can sign in and lands on /portal with placeholder', async ({ page }) => {
    await page.goto('/portal/sign-in');
    await page.waitForLoadState('networkidle');

    await expect(page.getByLabel(/email/i)).toBeFocused();
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/auth/sign-in') && r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      page.getByRole('button', { name: /sign in/i }).click(),
    ]);

    await page.waitForURL('**/portal', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /welcome|portal/i })).toBeVisible();
  });

  test('member attempting /admin is bounced back to /portal', async ({ page }) => {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/portal', { timeout: 30_000 });

    await page.goto('/admin');
    // Cross-portal guard in the staff layout — members get redirected.
    await page.waitForURL(/\/portal(\?|$)/, { timeout: 10_000 });
  });
});
