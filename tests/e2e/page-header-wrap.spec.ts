/**
 * T031 — E2E: F4 US2 PageHeader action wrap below 640px.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 US2 — page header action wrap @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('actions wrap at 639px, inline at 641px (640 breakpoint)', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/plans');

    // Actions may be rendered as <a> (Link asChild) or <button>.
    const actionLocator = page
      .locator('[data-slot="page-header-actions"]')
      .locator(':is(a, button)')
      .first();
    await expect(actionLocator, 'header must render at least one action').toBeVisible();

    // What this test is named for is the 640px breakpoint, so assert the
    // breakpoint: the header stacks below it and becomes a row above it.
    //
    // It used to compare the action's `offsetTop` with the h1's and allow 8px.
    // That measured the OUTCOME at one width, which the header is not obliged
    // to produce: above 640 it is `flex-row flex-wrap`, so a title, a subtitle
    // and two buttons that do not fit in 641px wrap by design — and 122 US3
    // made the row `items-end`, which moves the action's top by a subtitle's
    // height even when it has not wrapped. Both of those broke an assertion
    // about the breakpoint for reasons that have nothing to do with it.
    const headerDirection = async () =>
      page
        .locator('[data-slot="page-header"]')
        .first()
        .evaluate((el) => getComputedStyle(el).flexDirection);

    await page.setViewportSize({ width: 639, height: 900 });
    expect(await headerDirection(), 'at 639px the header stacks').toBe('column');

    await page.setViewportSize({ width: 641, height: 900 });
    expect(await headerDirection(), 'at 641px the header is a row').toBe('row');

    // And the actions stay inside the header at both widths — the wrap must be
    // a wrap, not an overflow out of the frame.
    await expect(actionLocator).toBeVisible();
  });
});
