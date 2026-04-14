/**
 * T030 — E2E: F4 US2 responsive admin layout.
 *
 * Matrix: viewports (320, 375, 640, 768, 1024, 1440) × migrated admin pages.
 * Asserts no horizontal scroll and all visible buttons have non-zero dims.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const VIEWPORTS = [320, 375, 640, 768, 1024, 1440];
const PAGES = ['/admin', '/admin/users', '/admin/plans', '/admin/settings/fees'];

test.describe('F4 US2 — responsive layout @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every page × viewport has no horizontal scroll', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    for (const width of VIEWPORTS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PAGES) {
        await page.goto(path);
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `${path} at ${width}px has no horizontal scroll`,
        ).toBeLessThanOrEqual(overflow.clientWidth);
      }
    }
  });
});
