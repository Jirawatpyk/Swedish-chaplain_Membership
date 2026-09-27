/**
 * T035 + T036 — E2E: F4 US3 breadcrumb navigation, as spec 122 redrew it.
 *
 * The leading `admin` portal-root segment is dropped (Stripe / Linear /
 * GitHub / Notion convention; the sidebar already names the portal).
 *
 * - From 1024px every page has a trail in the top bar: a top-level page
 *   shows itself as the current crumb (`/admin/users` → "Users"), a deeper
 *   page its parents too (`/admin/settings/invoicing` → Settings › Invoice
 *   settings).
 * - Below 1024px the boards draw a "← Parent" link above the page instead of
 *   the trail, and nothing on a top-level page.
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

  test('every page has a trail from 1024px: the current page alone at the top level, its parents below it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Use shared `signInAsSuperAdmin` helper — it routes the email +
    // password fills through `fillField` which has WebKit-specific
    // click→clear→pressSequentially handling.
    await signInAsSuperAdmin(page);

    // /admin/users → filtered=1 → the current page alone
    await page.goto('/admin/users');
    const crumbs = page.locator('[data-slot="breadcrumb-list"]:visible [data-slot="breadcrumb-item"]');
    await expect(crumbs).toHaveCount(1);
    await expect(crumbs.first().locator('[aria-current="page"]')).toBeVisible();

    // /admin/settings/invoicing → filtered=2 → [Settings, Invoice settings]
    await page.goto('/admin/settings/invoicing');
    await expect(crumbs).toHaveCount(2);
  });

  test('phones get a back link to the parent page, and none on a top-level page', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await signInAsSuperAdmin(page);

    // `renewals` has no page of its own, so the link skips it to Settings.
    await page.goto('/admin/settings/renewals/schedules');
    const back = page.locator('[data-slot="breadcrumb-back"]:visible');
    await expect(back).toHaveAttribute('href', '/admin/settings');

    await page.goto('/admin/users');
    await expect(back).toHaveCount(0);
  });
});
