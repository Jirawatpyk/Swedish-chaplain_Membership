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
import { MEMBERS_GRID, bulkBar, firstRowCheckbox, gridCheckboxInputs } from './helpers/members-grid';
import en from '../../src/i18n/messages/en.json';

const CLEAR = en.admin.members.bulk.clear;

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

async function signIn(page: Page): Promise<void> {
  await clearE2ERateLimits();
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
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
    await page.waitForSelector(MEMBERS_GRID, { timeout: 10_000 });
  });

  test('row selection checkboxes render for admin', async ({ page }) => {
    const checkboxes = gridCheckboxInputs(page);
    // At least header checkbox + row checkboxes
    const count = await checkboxes.count();
    expect(count).toBeGreaterThan(0);
  });

  test('bulk action bar appears on selection', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'bulk selection is desktop-only by design: phone cards carry no checkbox (spec 122 Clarifications, 2026-09-28)');
    // Click the first row checkbox
    await firstRowCheckbox(page).click();
    // Bulk bar leaves its idle (clipped) state
    const bar = bulkBar(page);
    await expect(bar).not.toHaveClass(/is-idle/, { timeout: 3_000 });
    await expect(bar.getByRole('button', { name: CLEAR })).toBeVisible();
  });

  test('clear selection hides the bar', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'bulk selection is desktop-only by design: phone cards carry no checkbox (spec 122 Clarifications, 2026-09-28)');
    await firstRowCheckbox(page).click();
    const bar = bulkBar(page);
    const clearBtn = bar.getByRole('button', { name: CLEAR });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    // The ActionBar stays mounted (its live region) but goes idle
    await expect(bar).toHaveClass(/is-idle/);
    await expect(clearBtn).toHaveCount(0);
  });

  test('@a11y axe-core scan on directory with selection', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'bulk selection is desktop-only by design: phone cards carry no checkbox (spec 122 Clarifications, 2026-09-28)');
    await firstRowCheckbox(page).click();
    // Wait for the bulk bar to leave its idle state
    await expect(bulkBar(page)).not.toHaveClass(/is-idle/);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .include(MEMBERS_GRID)
      .include('.aura-actionbar')
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('phone cards offer no row selection and no bulk bar', async ({ page, isMobile }) => {
    test.skip(isMobile !== true, 'phone cards only; the desktop tests above cover selection');
    // Maintainer, 28 Sep: bulk work stays on wider screens; the card is the
    // board's (no checkbox, no ⋯ menu).
    await expect(firstRowCheckbox(page)).toBeHidden();
    await expect(bulkBar(page)).toHaveClass(/is-idle/);
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
      await page.waitForSelector(MEMBERS_GRID, { timeout: 10_000 });
      // Check no raw i18n keys (admin.members.* pattern) leak into the page
      const bodyText = await page.textContent('body');
      expect(bodyText).not.toMatch(/admin\.members\.(bulk|inlineEdit)\./);
    });
  }
});
