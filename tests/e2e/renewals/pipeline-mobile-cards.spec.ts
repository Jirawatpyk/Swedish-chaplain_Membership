/**
 * `/admin/renewals` on a phone — one AURA table that stacks into cards
 * (spec 122 US7a, T702; Clarifications, Session 2026-09-30 US7 start).
 *
 * Below 640px the pipeline's AURA `DataTable` renders each row as a card
 * (`aura-table--stacked`); from 640px up it is the grid. There is no second
 * list. This spec locks that contract, the "no horizontal body scroll at
 * phone widths" guarantee and a WCAG 2.1 AA scan, and that selecting a card
 * keeps the LAST card reachable above the sticky bulk bar (WCAG 2.4.11).
 *
 * Requires `E2E_ADMIN_*` in `.env.local` + `FEATURE_F8_RENEWALS=true`.
 * Run:
 *   pnpm test:e2e tests/e2e/renewals/pipeline-mobile-cards.spec.ts --workers=1
 *
 * `runAxeScan` fails only on serious+critical; the authoritative a11y run is
 * the preview deploy (local dev has 320px-class target-size noise).
 *
 * Card assertions run only when the pipeline has a row for the signed-in
 * admin's tenant; the scroll and axe assertions hold for the empty state too.
 */
import { expect, test } from '../fixtures';
import { runAxeScan } from '../helpers/axe-scan';
import { signInAsAdmin } from '../helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

/** The pipeline grid in the work-queue panel (the tray below has its own table). */
function pipelineGrid(page: import('@playwright/test').Page) {
  return page.locator('#work-queue-panel').getByRole('grid', { name: /renewal pipeline/i });
}

/** Body rows (a header row holds no gridcell) — the cards when stacked. */
function pipelineRows(page: import('@playwright/test').Page) {
  return pipelineGrid(page).getByRole('row').filter({ has: page.getByRole('gridcell') });
}

async function hasHorizontalScroll(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.describe('/admin/renewals — one table, cards on a phone @a11y @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');
  test.skip(!F8_RENEWALS_ENABLED, 'FEATURE_F8_RENEWALS=false');

  test('375px — the pipeline table stacks into cards, no horizontal scroll, axe clean', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    const grid = pipelineGrid(page);
    await expect(grid).toBeVisible();
    await expect(page.locator('#work-queue-panel .aura-table--stacked')).toHaveCount(1);
    await expect(page.getByTestId('pipeline-card-list')).toHaveCount(0);

    expect(
      await hasHorizontalScroll(page),
      'document must not scroll horizontally at 375px',
    ).toBe(false);

    const cards = pipelineRows(page);
    if ((await cards.count()) > 0) {
      const firstCard = cards.first();
      // Company link + the row menu trigger on every card.
      await expect(firstCard.getByRole('link').first()).toBeVisible();
      await expect(firstCard.getByRole('button', { name: /^actions for/i })).toBeVisible();
    }

    await runAxeScan(page, test.info());
  });

  test('1280px — the same table is a grid, not cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(pipelineGrid(page)).toBeVisible();
    await expect(page.locator('#work-queue-panel .aura-table--stacked')).toHaveCount(0);
  });

  test('375px — selecting a card keeps the LAST card reachable above the sticky bulk bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    const cards = pipelineRows(page);
    const cardCount = await cards.count();
    test.skip(cardCount === 0, 'no seeded renewal cycles for this admin — nothing to select');

    // Select the FIRST card's checkbox — enough to mount the sticky
    // `PipelineBulkActionBar` (role="toolbar") without needing every row.
    await cards.first().getByRole('checkbox').click();
    const bar = page.getByRole('toolbar', { name: /bulk actions/i });
    await expect(bar).toBeVisible();

    // Scroll the LAST card fully into view, then assert its bottom edge
    // sits ABOVE the sticky bar's top edge — the bar's measured
    // `ResizeObserver` spacer (mirrors `admin/members/_components/
    // bulk-action-bar.tsx`) must never leave the last card's controls
    // covered by the bar (WCAG 2.4.11 Focus Not Obscured).
    //
    // Park the last card half under the bar first. Otherwise, with one
    // seeded card, the checkbox click has already scrolled it into view and
    // the assertion below passes without measuring anything.
    const lastCard = cards.last();
    const parkedBarBox = await bar.boundingBox();
    const parkedCardBox = await lastCard.boundingBox();
    if (parkedBarBox && parkedCardBox) {
      const dy = parkedCardBox.y - (parkedBarBox.y + 20);
      await page.evaluate((y) => window.scrollBy(0, y), dy);
    }
    await lastCard.scrollIntoViewIfNeeded();
    const [cardBox, barBox] = await Promise.all([
      lastCard.boundingBox(),
      bar.boundingBox(),
    ]);
    expect(cardBox).not.toBeNull();
    expect(barBox).not.toBeNull();
    if (cardBox && barBox) {
      expect(
        cardBox.y + cardBox.height,
        'last card bottom edge must not be covered by the sticky bulk-action bar',
      ).toBeLessThanOrEqual(barBox.y + 1);
    }
  });
});
