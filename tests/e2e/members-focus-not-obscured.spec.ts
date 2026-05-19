/**
 * T146 — E2E: WCAG 2.2 SC 2.4.11 focus-not-obscured by bulk toolbar.
 *
 * @f3 @a11y
 *
 * Walks the member directory table with keyboard-only navigation
 * while the sticky bulk-action toolbar is visible, and verifies that
 * the focused element's bounding box is not fully occluded by the
 * toolbar's bounding box (ADOPT-01 WCAG 2.2 SC 2.4.11).
 *
 * The test:
 *   1. Signs in and navigates to /admin/members
 *   2. Selects one row (reveals bulk bar)
 *   3. Tabs through the remaining interactive elements
 *   4. For each focused element, checks that at least 1 px of its
 *      bounding box is above the bulk toolbar's top edge
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members focus-not-obscured by bulk toolbar @f3 @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  test('focused elements not fully obscured by sticky bulk toolbar', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    // Select first row to make the bulk toolbar visible
    const firstCheckbox = page
      .locator('tbody tr:first-child [data-slot="checkbox"]')
      .first();
    await firstCheckbox.click();

    const bulkBar = page.getByRole('toolbar');
    await expect(bulkBar).toBeVisible({ timeout: 5_000 });

    // Get bulk toolbar's top edge (it's fixed to the bottom)
    const bulkBarBox = await bulkBar.boundingBox();
    if (!bulkBarBox) return;
    const bulkBarTop = bulkBarBox.y;

    // Tab through a few elements and check none are fully behind the toolbar
    const MAX_TABS = 10;
    for (let i = 0; i < MAX_TABS; i++) {
      await page.keyboard.press('Tab');

      const focusedBox: { x: number; y: number; width: number; height: number } | null =
        await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });

      if (!focusedBox) continue;

      const focusedBottom = focusedBox.y + focusedBox.height;

      // WCAG 2.2 SC 2.4.11: at least some part of the focused element must
      // be visible (not fully covered). The element top must be < bulkBarTop
      // OR the element is entirely above the toolbar.
      const fullyObscured =
        focusedBox.y >= bulkBarTop && focusedBottom <= bulkBarBox.y + bulkBarBox.height;

      expect(
        fullyObscured,
        `Element at y=${focusedBox.y} is fully obscured by toolbar at y=${bulkBarTop}`,
      ).toBe(false);
    }
  });
});
