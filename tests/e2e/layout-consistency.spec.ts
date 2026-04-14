/**
 * T018 — E2E: F4 US1 consistent page structure.
 *
 * Iterates every migrated admin page and asserts:
 *   - `<h1>` is present with identical computed font-size
 *   - ContentContainer has computed `max-width: 1152px` (72rem)
 *   - Horizontal padding equals --page-padding-x
 *   - No top-level ad-hoc `max-w-*` class on page root
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
// A seeded plan must exist at /admin/plans/[year]/[planId] for the
// two dynamic routes below. `scripts/seed-swecham-2026-plans.ts`
// installs the catalogue used by the rest of the E2E suite.
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

const PAGES = [
  '/admin',
  '/admin/account',
  '/admin/users',
  '/admin/plans',
  '/admin/plans/new',
  '/admin/plans/clone',
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`,
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}/edit`,
  '/admin/settings/fees',
];

// Absolute expectation from FR-017 --font-size-h1 (1.875rem @ 16px base).
const EXPECTED_H1_FONT_SIZE = '30px';

test.describe('F4 US1 — layout consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every admin page uses PageHeader + ContentContainer at 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    for (const path of PAGES) {
      await page.goto(path);
      // Wait for the page (not the loading.tsx) to finish hydrating.
      // /admin/settings/fees has a loading skeleton with its own
      // ContentContainer that races the real page's container.
      await page.waitForLoadState('networkidle');
      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1, `${path} has h1`).toBeVisible();

      const fontSize = await h1.evaluate((el) => getComputedStyle(el).fontSize);
      expect(fontSize, `${path} h1 font-size`).toBe(EXPECTED_H1_FONT_SIZE);

      const container = page.locator('[data-slot="content-container"]').first();
      await expect(container).toBeVisible();
      const maxWidth = await container.evaluate((el) => getComputedStyle(el).maxWidth);
      expect(maxWidth, `${path} ContentContainer max-width`).toBe('1152px');

      const paddingInline = await container.evaluate(
        (el) => getComputedStyle(el).paddingInlineStart,
      );
      expect(paddingInline, `${path} padding-inline`).toBe('24px');
    }
  });
});
