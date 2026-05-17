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

    // Just below the 640px breakpoint — action must wrap below h1.
    await page.setViewportSize({ width: 639, height: 900 });
    const narrowH1Top = await page.getByRole('heading', { level: 1 }).evaluate(
      (el) => (el as HTMLElement).offsetTop,
    );
    const narrowActionTop = await actionLocator.evaluate(
      (el) => (el as HTMLElement).offsetTop,
    );
    expect(narrowActionTop, 'at 639px actions wrap below h1').toBeGreaterThan(narrowH1Top);

    // Just above the 640px breakpoint — inline (same row as h1).
    await page.setViewportSize({ width: 641, height: 900 });
    const wideH1Top = await page.getByRole('heading', { level: 1 }).evaluate(
      (el) => (el as HTMLElement).offsetTop,
    );
    const wideActionTop = await actionLocator.evaluate(
      (el) => (el as HTMLElement).offsetTop,
    );
    expect(
      Math.abs(wideActionTop - wideH1Top),
      'at 641px actions inline with h1',
    ).toBeLessThanOrEqual(8);
  });
});
