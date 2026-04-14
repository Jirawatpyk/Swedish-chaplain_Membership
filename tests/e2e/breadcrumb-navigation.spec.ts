/**
 * T035 + T036 — E2E: F4 US3 breadcrumb navigation + mobile truncation.
 *
 * - Depth ≥ 3 renders trail
 * - Depth < 3 renders no breadcrumb
 * - Mobile (<640px) truncates to parent + current with ellipsis
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 US3 — breadcrumb navigation @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('depth < 3 pages render no breadcrumb; depth ≥ 3 do', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    // /admin/users → depth 2 → no breadcrumb
    await page.goto('/admin/users');
    await expect(page.locator('[data-slot="breadcrumb"]')).toHaveCount(0);

    // /admin/settings/fees → depth 3 → breadcrumb
    await page.goto('/admin/settings/fees');
    // Component renders both desktop + mobile breadcrumb lists for
    // responsive switching; count only the visible (desktop) list.
    const crumbs = page
      .locator('[data-slot="breadcrumb-list"]:visible [data-slot="breadcrumb-item"]');
    await expect(crumbs.first()).toBeVisible();
    await expect(crumbs).toHaveCount(3);
  });

  test('mobile truncation shows ellipsis + parent + current', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/settings/fees');
    const ellipsis = page.locator('[data-slot="breadcrumb-ellipsis"]');
    await expect(ellipsis).toBeVisible();
  });
});
