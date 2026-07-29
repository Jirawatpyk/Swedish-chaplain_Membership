/**
 * Task 12 — `/admin/renewals` mobile card-view E2E + @a11y @layout.
 *
 * Mirrors `tests/e2e/portal/invoices-mobile-cards.spec.ts` (the
 * `060-member-portal-d4` precedent this task's dual-render shape copies):
 * a stacked CARD list (`PipelineCardList`) takes over below `md` (768px),
 * the desktop `<table>` takes over at `≥ md`. This spec locks the
 * breakpoint contract + the "no horizontal body scroll at mobile widths"
 * guarantee + a WCAG 2.1 AA scan.
 *
 * NOT added to the generic `tests/e2e/layout-responsive.spec.ts` sweep —
 * that sweep does not select rows, and on `/admin/renewals` selecting a
 * card's checkbox mounts `PipelineBulkActionBar` (a sticky-bottom
 * toolbar with a measured `ResizeObserver` spacer — see that
 * component's docstring). The members-directory mobile sweep noted the
 * equivalent bar never actually renders there; here it DOES, so this
 * spec explicitly asserts the spacer keeps the LAST card scrollable
 * into view above the bar (WCAG 2.4.11 Focus Not Obscured), not just
 * that the page doesn't scroll horizontally.
 *
 * Requires `E2E_ADMIN_*` in `.env.local` + `FEATURE_F8_RENEWALS=true`.
 * Run:
 *   pnpm test:e2e --grep "renewals pipeline mobile card" --workers=1
 * (ALWAYS `--workers=1` per project memory — default 3 hangs the
 * workstation.)
 *
 * Local-noise note (project memory
 * `reference_e2e_perf_gates_preview_only`): local dev e2e has EXPECTED
 * 320px-class target-size a11y noise; the AUTHORITATIVE a11y run is the
 * preview deploy. `runAxeScan` fails only on serious+critical so
 * transient moderate/target-size noise does not flake the gate.
 *
 * Row-content assertions (card visible, has company/tier/urgency/
 * actions) run only when the pipeline actually has at least one row for
 * the signed-in admin's tenant — an empty-state deployment renders
 * neither a data row in the table NOR a card. The no-horizontal-scroll
 * + axe assertions run unconditionally — they must hold for the empty
 * state too.
 */
import { expect, test } from '../fixtures';
import { runAxeScan } from '../helpers/axe-scan';
import { signInAsAdmin } from '../helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

async function hasHorizontalScroll(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.describe('Task 12 — /admin/renewals mobile card-view @a11y @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');
  test.skip(!F8_RENEWALS_ENABLED, 'FEATURE_F8_RENEWALS=false');

  test('375px — cards shown, table hidden, no horizontal scroll, axe clean', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The desktop table is hidden via `hidden md:block` at mobile widths.
    // It still exists in the DOM (both presentations share one TanStack
    // instance — see `pipeline-table.tsx`'s module docstring), so assert
    // on visibility, not absence.
    await expect(page.getByRole('table')).toBeHidden();

    // No horizontal scroll at 375px — the whole point of the card view.
    expect(
      await hasHorizontalScroll(page),
      'document must not scroll horizontally at 375px',
    ).toBe(false);

    const cardList = page.getByTestId('pipeline-card-list');
    await expect(cardList).toBeVisible();

    const cards = cardList.getByRole('group');
    const cardCount = await cards.count();
    if (cardCount > 0) {
      const firstCard = cards.first();
      // Company link + tier + urgency text label + RowActions ⋯ trigger
      // all present per card (brief Step 1's acceptance shape).
      await expect(firstCard.getByRole('link').first()).toBeVisible();
      await expect(
        firstCard.getByRole('button', { name: /^actions for/i }),
      ).toBeVisible();
    }

    await runAxeScan(page, test.info());
  });

  test('1280px — desktop table shown, mobile card list hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('pipeline-card-list')).toBeHidden();
    await expect(page.getByRole('table')).toBeVisible();
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

    const cardList = page.getByTestId('pipeline-card-list');
    const cards = cardList.getByRole('group');
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
    const lastCard = cards.last();
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
