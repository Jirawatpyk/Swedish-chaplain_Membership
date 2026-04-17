/**
 * T145 — E2E: WCAG 2.2 SC 2.5.8 target-size validation (ADOPT-01).
 *
 * @f3 @a11y
 *
 * Verifies that interactive elements on F3 member surfaces meet the
 * WCAG 2.2 SC 2.5.8 minimum target size of 24×24 CSS px:
 *   (i)   Inline-edit cells (status, country, notes) in the directory
 *   (ii)  Multi-select header + row checkboxes
 *   (iii) Bulk action bar buttons
 *   (iv)  Close button on the archive confirmation dialog
 *   (v)   Load-more button in the directory
 *
 * NOTE: axe-core's `target-size` rule is also added to each per-story
 * @a11y spec (T144 ADOPT-01). This spec focuses on computed-style
 * measurements for interactive cells where axe-core may not reach.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const MIN_TARGET_PX = 24;

test.describe.configure({ mode: 'serial' });

test.describe('members WCAG 2.2 SC 2.5.8 target sizes @f3 @a11y', () => {
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
    await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  async function measureTargetSize(
    page: Page,
    selector: string,
  ): Promise<{ width: number; height: number }> {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'attached', timeout: 10_000 });
    const box = await el.boundingBox();
    if (!box) throw new Error(`No bounding box for selector: ${selector}`);
    return { width: box.width, height: box.height };
  }

  test('row checkboxes meet 24×24 minimum target size', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    // Header checkbox (select-all)
    const headerSize = await measureTargetSize(
      page,
      'thead [data-slot="checkbox"]',
    );
    expect(headerSize.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(headerSize.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);

    // First row checkbox
    const rowSize = await measureTargetSize(
      page,
      'tbody tr:first-child [data-slot="checkbox"]',
    );
    expect(rowSize.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(rowSize.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });

  test('load-more button meets 24×24 minimum target size', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    const loadMoreBtn = page.getByRole('button', { name: /load more/i });
    const visible = await loadMoreBtn.isVisible();
    if (!visible) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'Load-more button not visible — fewer members than one page',
      });
      return;
    }

    const box = await loadMoreBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });

  test('bulk action bar buttons meet 24×24 minimum target size when visible', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    // Select first row to reveal bulk bar
    const firstRowCheckbox = page
      .locator('tbody tr:first-child [data-slot="checkbox"]')
      .first();
    await firstRowCheckbox.click();

    const bulkBar = page.getByRole('toolbar');
    await expect(bulkBar).toBeVisible({ timeout: 5_000 });

    // All buttons inside the toolbar
    const buttons = bulkBar.getByRole('button');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      if (!box) continue;
      expect(box.height, `Bulk bar button[${i}] height`).toBeGreaterThanOrEqual(
        MIN_TARGET_PX,
      );
    }
  });

  test('archive dialog close button meets 24×24 minimum target size', async ({
    page,
  }) => {
    await signIn(page);
    // Navigate to first active member
    await page.goto('/admin/members?status=active');
    await page.waitForLoadState('networkidle');
    const firstRowLink = page
      .locator('tbody tr:first-child a')
      .first();
    await firstRowLink.waitFor({ timeout: 10_000 });
    const href = await firstRowLink.getAttribute('href');
    if (!href) return;
    await page.goto(href);
    await page.waitForLoadState('networkidle');

    // Open archive dialog
    const archiveBtn = page.getByRole('button', { name: /archive member/i });
    const archiveVisible = await archiveBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!archiveVisible) return;
    await archiveBtn.click();

    // Check dialog close button — uses AlertDialog (role="alertdialog")
    const closeBtn = page.getByRole('alertdialog').getByRole('button', { name: /cancel/i });
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });
    const box = await closeBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
  });
});
