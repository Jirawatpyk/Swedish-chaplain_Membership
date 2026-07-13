/**
 * T056 — E2E: F4 axe-core WCAG 2.1 AA regression scan.
 *
 * Tagged `@a11y` for the filtered run.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const PAGES = [
  '/admin',
  '/admin/users',
  '/admin/plans',
  '/admin/plans/new',
  '/admin/plans/clone',
  '/admin/settings/invoicing',
];

test.describe('F4 — layout a11y regressions @a11y @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every migrated admin page passes WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    for (const path of PAGES) {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations, `${path} has zero WCAG 2.1 AA violations`).toEqual([]);
    }
  });
});
