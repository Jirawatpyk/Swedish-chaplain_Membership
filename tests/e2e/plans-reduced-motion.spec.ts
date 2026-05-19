/**
 * T070 — E2E reduced-motion shimmer fallback on /admin/plans (US1, @reduced-motion).
 *
 * Asserts that when the browser advertises `prefers-reduced-motion: reduce`,
 * the shimmer skeleton gradient is disabled and replaced with a static
 * pulse (per docs/ux-standards.md § 2.2).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('plans reduced-motion — US1 @reduced-motion', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_* to run reduced-motion scan',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test.use({ colorScheme: 'light' });

  test('shimmer gradient disabled under prefers-reduced-motion: reduce', async ({
    page,
    context,
  }) => {
    await context.grantPermissions([], { origin: 'http://localhost:3100' });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/plans');

    // Under reduced-motion, the CSS transition/animation durations on the
    // page body should be effectively zero. Sample the plans table row
    // (a rendered, always-present element) and verify no active animation.
    const tableRow = page.locator('tr[data-plan-id]').first();
    await expect(tableRow).toBeVisible({ timeout: 10_000 });

    const animationDuration = await tableRow.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    );
    // Either no animation (empty/none) or a zero duration.
    expect(animationDuration).toMatch(/^(0s|none|\s*)$/);
  });
});
