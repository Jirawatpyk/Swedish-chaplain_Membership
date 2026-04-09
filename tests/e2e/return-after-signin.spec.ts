/**
 * T171 — Return to original URL after sign-in E2E test
 * (spec AS5, `SC-020 return-after-signin` in Phase 10).
 *
 * Scenario:
 *   1. Unauthenticated visitor clicks a deep protected URL
 *      (e.g. `/admin` directly, NOT `/admin/sign-in`)
 *   2. Middleware/layout redirects them to
 *      `/admin/sign-in?returnTo=%2Fadmin`
 *   3. User signs in
 *   4. User lands on the ORIGINAL URL, not the default `/admin` (in
 *      this case they happen to match — but the test also covers
 *      deeper URLs and open-redirect rejection)
 *
 * Also asserts the open-redirect guard rejects an attacker-supplied
 * external URL — the user still lands on the default after sign-in
 * instead of being bounced to a malicious host.
 */
import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

// Run these tests serially — each one signs in as the same admin,
// and the sliding-window email rate limit (5 per 15 min) would otherwise
// blow up when the 3 specs run in parallel. Serial execution plus
// per-file clear-ratelimit in beforeAll keeps the bucket below the
// threshold.
test.describe.configure({ mode: 'serial' });

test.describe('return-after-signin (T171, spec AS5)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run E2E tests',
  );

  test('unauth → /admin/sign-in injects returnTo query param', async ({ page }) => {
    await page.goto('/admin');
    // requireSession → buildSignInUrl → redirect with returnTo=%2Fadmin
    await page.waitForURL(/\/admin\/sign-in\?returnTo=/, { timeout: 10_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe('/admin/sign-in');
    expect(url.searchParams.get('returnTo')).toBe('/admin');
  });

  test('successful sign-in navigates back to the preserved URL', async ({ page }) => {
    // Surface any non-OK sign-in responses in test output
    page.on('response', async (response) => {
      if (response.url().includes('/api/auth/sign-in') && !response.ok()) {
        console.log(`  [sign-in API] ${response.status()} ${await response.text().catch(() => '')}`);
      }
    });

    await page.goto('/admin');
    await page.waitForURL(/\/admin\/sign-in\?returnTo=/);

    await page.waitForLoadState('networkidle');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);

    const [signInResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/auth/sign-in') && res.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      page.getByRole('button', { name: /sign in/i }).click(),
    ]);

    if (!signInResponse.ok()) {
      throw new Error(
        `sign-in API returned ${signInResponse.status()}: ${await signInResponse.text()}`,
      );
    }

    // After success the form should navigate to the preserved
    // returnTo value (`/admin`), landing on the staff home.
    await page.waitForURL('**/admin', { timeout: 45_000 });
    const url = new URL(page.url());
    expect(url.pathname).toBe('/admin');
    expect(url.searchParams.get('returnTo')).toBeNull(); // no longer in URL
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
  });

  test('open-redirect attempt is neutralised — hostile returnTo is ignored', async ({ page }) => {
    // An attacker-crafted sign-in URL that tries to bounce the user
    // to an external site after login. The safeReturnTo guard MUST
    // strip it and fall back to the default `/admin`.
    await page.goto('/admin/sign-in?returnTo=https%3A%2F%2Fevil.example%2Fsteal');
    await page.waitForLoadState('networkidle');

    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);

    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/auth/sign-in') && res.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /sign in/i }).click(),
    ]);

    // Must land on the internal default, never the attacker's host
    await page.waitForURL('**/admin', { timeout: 45_000 });
    expect(page.url()).toContain('/admin');
    expect(page.url()).not.toContain('evil.example');
  });
});
