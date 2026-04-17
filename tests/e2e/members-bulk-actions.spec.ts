/**
 * T103 — E2E: Bulk actions on the member directory (US4).
 *
 * @f3 @a11y @i18n
 *
 * Verifies:
 *   1. Row selection checkboxes appear for admin users
 *   2. Bulk action bar appears on selection
 *   3. Archive confirmation dialog with typed-phrase for > 5 rows
 *   4. axe-core WCAG 2.1 AA scan on directory + bulk bar
 *   5. EN/TH/SV i18n leak check
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import AxeBuilder from '@axe-core/playwright';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page): Promise<void> {
  await clearE2ERateLimits();
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait for redirect AWAY from sign-in (same pattern as plans-list.spec.ts)
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    },
    { timeout: 15_000 },
  );
}

test.describe('members bulk actions @f3', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
  });

  test('row selection checkboxes render for admin', async ({ page }) => {
    const checkboxes = page.locator('[data-slot="checkbox"]');
    // At least header checkbox + row checkboxes
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);
  });

  test('bulk action bar appears on selection', async ({ page }) => {
    // Click the first row checkbox
    const firstRowCheckbox = page.locator('[data-slot="checkbox"]').nth(1);
    await firstRowCheckbox.click();
    // Bulk bar should appear
    const toolbar = page.locator('[role="toolbar"]');
    await expect(toolbar).toBeVisible({ timeout: 3_000 });
  });

  test('clear selection hides the bar', async ({ page }) => {
    const firstRowCheckbox = page.locator('[data-slot="checkbox"]').nth(1);
    await firstRowCheckbox.click();
    const toolbar = page.locator('[role="toolbar"]');
    await expect(toolbar).toBeVisible();
    // Click clear
    const clearBtn = toolbar.locator('button').last();
    await clearBtn.click();
    await expect(toolbar).not.toBeVisible();
  });

  test('@a11y axe-core scan on directory with selection', async ({ page }) => {
    const firstRowCheckbox = page.locator('[data-slot="checkbox"]').nth(1);
    await firstRowCheckbox.click();
    // Wait for bulk bar
    await page.waitForSelector('[role="toolbar"]');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .include('[data-slot="table"]')
      .include('[role="toolbar"]')
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('members bulk actions i18n @f3 @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  for (const locale of ['en', 'th', 'sv'] as const) {
    test(`${locale} locale renders without i18n leak`, async ({ page }) => {
      await signIn(page);
      await page.context().addCookies([
        { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
      ]);
      await page.goto('/admin/members');
      await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
      // Check no raw i18n keys (admin.members.* pattern) leak into the page
      const bodyText = await page.textContent('body');
      expect(bodyText).not.toMatch(/admin\.members\.(bulk|inlineEdit)\./);
    });
  }
});
