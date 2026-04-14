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
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/plans');

    // The skeleton placeholder should be present initially with a
    // `data-reduced-motion="true"` attribute when reduced-motion fires.
    // The real UI swaps the shimmer gradient for a static pulse.
    const skeleton = page.locator('[data-plan-list-skeleton]').first();
    // Skeleton may disappear fast after hydration — don't block on visibility,
    // just look for the reduced-motion marker on the shell element that
    // wraps the skeleton.
    const shell = page.locator('[data-reduced-motion]').first();
    if (await shell.count() > 0) {
      await expect(shell).toHaveAttribute('data-reduced-motion', 'true');
    } else {
      // Fallback: check the computed style on a skeleton cell
      const animation = await skeleton.evaluate((el) =>
        el ? window.getComputedStyle(el).animationDuration : '0s',
      );
      expect(animation).toMatch(/^0s|none/);
    }
  });
});
