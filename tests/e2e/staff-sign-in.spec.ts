/**
 * T063 — Staff sign-in happy-path E2E test (Playwright).
 *
 * Opens /admin/sign-in, fills the form, submits, asserts redirect
 * to /admin and that the shell user-menu shows the admin's name +
 * role badge.
 *
 * Credentials are read from env vars to avoid committing secrets:
 *   E2E_ADMIN_EMAIL     - the bootstrap admin email (e.g. from
 *                          `pnpm db:seed-admin`)
 *   E2E_ADMIN_PASSWORD  - the bootstrap admin password
 *
 * Both must be present for the test to run; missing env vars skip
 * the test with a helpful message.
 *
 * Run locally with:
 *   E2E_ADMIN_EMAIL=jirawat.p@eqho.com \
 *   E2E_ADMIN_PASSWORD='...' \
 *   pnpm test:e2e tests/e2e/staff-sign-in.spec.ts
 *
 * The `playwright.config.ts` `webServer` section auto-starts
 * `pnpm dev`, so no separate terminal is needed.
 */
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

// Serialize the 3 tests in this file so successive sign-ins don't
// race into the per-email rate-limit bucket.
test.describe.configure({ mode: 'serial' });

test.describe('staff sign-in (happy path)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run E2E tests',
  );

  test.beforeAll(async () => {
    // Wipe rate-limit buckets so the 5/15-min per-email cap doesn't
    // trip when a previous spec has already consumed the budget.
    await clearE2ERateLimits();
  });

  test('admin can sign in and lands on /admin with user menu visible', async ({ page }) => {
    // Capture non-OK sign-in responses so a rate-limit failure is
    // obvious in the test output instead of showing as a navigation
    // timeout.
    page.on('response', async (response) => {
      if (response.url().includes('/api/auth/sign-in') && !response.ok()) {
        console.log(`  [sign-in API] ${response.status()} ${await response.text().catch(() => '')}`);
      }
    });

    await page.goto('/admin/sign-in');
    await page.waitForLoadState('networkidle');

    // Auto-focus should put the cursor on the email field (spec FR-024)
    await expect(page.getByLabel(/email/i)).toBeFocused();

    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);

    // Wait for the sign-in API response AND the click to register
    // together; throw a descriptive error if the API rejects.
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

    // Navigation to /admin — Turbopack cold compile can take 20+ s
    // on first hit, so give it plenty of headroom.
    await page.waitForURL('**/admin', { timeout: 45_000 });
    expect(page.url()).toContain('/admin');

    // Welcome heading + user menu trigger
    await expect(page.getByRole('heading', { name: /welcome/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /account menu/i })).toBeVisible();
  });

  test('wrong password keeps the user on the sign-in page with an error banner', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByLabel(/password/i), 'deliberately-wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Still on the sign-in page (no redirect)
    await expect(page).toHaveURL(/\/admin\/sign-in$/);

    // Next.js injects its own <div role="alert" id="__next-route-announcer__">
    // at the top of the body, so getByRole('alert') returns that
    // (empty) element first. Filter by the expected text to land on
    // the SignInForm error banner.
    await expect(
      page.locator('[role="alert"]').filter({ hasText: /email or password/i }),
    ).toBeVisible();
  });

  test('sign-out clears the session and redirects back to sign-in', async ({ page }) => {
    // Sign in first
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 15_000 });

    // Open the user menu — shadcn DropdownMenu (Base UI) renders the
    // content in a portal with role="menu", items as role="menuitem".
    await page.getByRole('button', { name: /account menu/i }).click();

    // Match the menu item by visible text. Base UI might use
    // role="menuitem" OR the content might be a plain button inside
    // the portal, so we use getByText which works for both.
    await page
      .getByRole('menu')
      .getByText(/sign out/i)
      .click();

    // Should land back on sign-in. Use a regex so the assertion
    // passes whether or not the URL has a `?returnTo=...` query,
    // because T171 (return-URL preservation) may inject one when the
    // sign-out navigation is triggered from a protected layout.
    await page.waitForURL(/\/admin\/sign-in(\?|$)/, { timeout: 10_000 });

    // Revisiting /admin should redirect to sign-in again (session cleared).
    // With T171, requireSession() appends ?returnTo=%2Fadmin.
    await page.goto('/admin');
    await page.waitForURL(/\/admin\/sign-in(\?|$)/, { timeout: 10_000 });
  });
});
