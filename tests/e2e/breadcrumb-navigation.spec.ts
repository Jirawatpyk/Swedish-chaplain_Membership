/**
 * T035 + T036 — E2E: F4 US3 breadcrumb navigation + mobile truncation.
 *
 * Updated for the SaaS-convention filter that drops the leading
 * `admin` portal-root segment from the breadcrumb (Stripe / Linear /
 * GitHub / Notion convention; sidebar branding + role badge already
 * indicate the portal).
 *
 * - Filtered depth ≥ 2 renders trail (raw depth ≥ 3 typically; e.g.
 *   `/admin/settings/invoicing` raw=3 → filtered=2 → renders).
 * - Filtered depth < 2 renders no breadcrumb (e.g. `/admin/users`
 *   raw=2 → filtered=1 → no breadcrumb; sidebar + h1 covers it).
 * - Mobile (<640px) truncates to parent + current with ellipsis when
 *   filtered depth > 2 (e.g. `/admin/settings/renewals/schedules`
 *   raw=4 → filtered=3 → ellipsis fires).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
// 016 D4 (cutover 2026-08-11): this journey opens surfaces that are now
// superAdminOnly, so it signs in as super_admin. Post-Migration-C every human
// admin IS a super_admin, so this is also the realistic operator persona.
import { signInAsSuperAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe('F4 US3 — breadcrumb navigation @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_SUPER_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('filtered-depth < 2 renders no breadcrumb; filtered-depth ≥ 2 does', async ({ page }) => {
    // Use shared `signInAsSuperAdmin` helper — it routes the email +
    // password fills through `fillField` which has WebKit-specific
    // click→clear→pressSequentially handling. Inline `.fill()` calls
    // (the previous shape of this test) deterministically failed on
    // mobile-safari at the post-sign-in `waitForURL` because Safari
    // didn't register the controlled-input value before the form
    // submitted.
    await signInAsSuperAdmin(page);

    // /admin/users → raw=2 → filtered=1 (admin dropped) → no breadcrumb
    await page.goto('/admin/users');
    await expect(page.locator('[data-slot="breadcrumb"]')).toHaveCount(0);

    // /admin/settings/invoicing → raw=3 → filtered=2 → breadcrumb
    // shows [Settings, Invoice settings] (admin segment dropped).
    await page.goto('/admin/settings/invoicing');
    // Component renders both desktop + mobile breadcrumb lists for
    // responsive switching; count only the visible (desktop) list.
    const crumbs = page
      .locator('[data-slot="breadcrumb-list"]:visible [data-slot="breadcrumb-item"]');
    await expect(crumbs.first()).toBeVisible();
    await expect(crumbs).toHaveCount(2);
  });

  test('mobile truncation shows ellipsis + parent + current', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await signInAsSuperAdmin(page);

    // /admin/settings/renewals/schedules → raw=4 → filtered=3 (admin
    // dropped). Mobile truncation triggers when filtered > 2.
    await page.goto('/admin/settings/renewals/schedules');
    const ellipsis = page.locator('[data-slot="breadcrumb-ellipsis"]');
    await expect(ellipsis).toBeVisible();
  });
});
