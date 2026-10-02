/**
 * T080 — E2E: F4 SC-013 table row/cell consistency.
 *
 * SC-013 (`specs/004-page-layout-standard/spec.md:265`) names two tables
 * exactly: "Row heights, cell padding, and hover backgrounds are identical
 * across the Users table and the Plans list table." Spec 122 migrated the Plans
 * table to AURA `Table` and left `/admin/users` on the legacy kit (plan.md:136
 * puts Users in phase 10), so measured on the dev server, 2026-10-02:
 *
 *   /admin/users  legacy `td.px-[var(--table-cell-padding-x)]`  12px / 8px, row 45px,   thead sticky
 *   /admin/plans  AURA   `td.aura-tbl__td`                      16px / 8px, row 48.5px, thead static
 *
 * padding-y and row height already agree (8px both, 3.5px apart). The inline
 * padding does not: `--table-cell-padding-x` is 0.75rem, AURA's cell is
 * `padding: ... var(--aura-space-4)` (16px). That is the whole of the remaining
 * SC-013 gap, and it closes when `/admin/users` migrates — so it is one
 * `test.fail()` below rather than a red suite, and Playwright will say so
 * loudly on the day it starts passing.
 *
 * Two traps this spec previously fell into, both worth keeping in mind when
 * phase 10 lands:
 *
 *  - **The first cell is not a cell padding.** `.aura-tbl__td:first-child` takes
 *    `padding-left: var(--aura-space-6)` (24px) so the table's content lines up
 *    with the card's own 24px inset. The old code took "the first `td` whose
 *    paddingLeft > 0", which on AURA is that gutter, and reported a 12-vs-24
 *    drift that does not exist. Measure a MIDDLE cell.
 *  - **Phase 10 moves Users to AURA `DataTable`, not `Table`.** DataTable
 *    renders no `table` element at all — 50 `.aura-table__row` divs whose
 *    `.aura-table__td` cells are spans with `padding-left: 0`, because the 24px
 *    inset is a separate `.aura-table__gutter` element. `tbody tr` will find
 *    nothing and this spec will time out rather than fail an assertion. At that
 *    point SC-013 needs a decision, not a selector: the two pages will be using
 *    two different AURA table components on purpose, and "identical cell
 *    padding" across them is not a thing either component promises.
 *
 * Sticky headers are NOT part of SC-013's wording, but FR-020 (spec 004) asks
 * for them. AURA 5.26 (#129) gave `Table` a `stickyHeader` that pins the header
 * row to the page under the shell's top bar, and `/admin/plans` passes it: the
 * last test scrolls the page and checks the header row stays in view. (AURA
 * `DataTable`'s head pins only inside its own scroll box, which needs a fixed
 * `height`, so `/admin/directory` and the other DataTable lists do not pin to
 * the page; that is a separate decision.)
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsSuperAdmin } from './helpers/admin-session';
import { clearE2ERateLimits } from './helpers/rate-limit';

// `/admin/users` is super-admin only under RBAC v2 (`users.manage` is
// `superAdminOnly`): a plain admin gets the "Page not available" screen, which
// has no table at all, so this spec reads the super-admin vars as
// `layout-consistency.spec.ts` does.
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

interface RowMetrics {
  readonly rowHeight: number;
  readonly cellPaddingX: string | undefined;
  readonly cellPaddingY: string | undefined;
}

/**
 * A MIDDLE cell of the first body row — never the first or last, which carry the
 * table's own edge inset rather than a cell padding.
 */
async function probeRow(page: Page, path: string): Promise<RowMetrics> {
  await page.goto(path);
  // `:visible`, not `.first()`: Next keeps the previous segment's DOM in the
  // tree (hidden) after a client nav, and this walks two routes.
  const row = page.locator('tbody tr:visible').first();
  await row.waitFor({ timeout: 15_000 });
  return row.evaluate((el) => {
    const cells = Array.from(el.querySelectorAll('td'));
    const middle = cells.slice(1, -1).find((cell) => {
      // Action and checkbox columns carry pr-0 / pl-0 for icon alignment.
      const cellCs = getComputedStyle(cell);
      return parseFloat(cellCs.paddingLeft) > 0 && parseFloat(cellCs.paddingRight) > 0;
    });
    const cs = middle ? getComputedStyle(middle) : null;
    return {
      rowHeight: el.getBoundingClientRect().height,
      cellPaddingX: cs?.paddingLeft,
      cellPaddingY: cs?.paddingTop,
    };
  });
}

test.describe('F4 SC-013 — data table consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_SUPER_ADMIN_* not set');
  // Row height and cell padding are a desktop-table contract. Below `sm` the
  // plans table stacks into cards (spec 122 US6), so there is no row to measure
  // and nothing to compare against the users table.
  test.skip(
    ({ isMobile }) => isMobile === true,
    'table metrics are a desktop surface; phones get stacked cards',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('Users + Plans rows agree on height and vertical cell padding', async ({ page }) => {
    await signInAsSuperAdmin(page);

    const users = await probeRow(page, '/admin/users');
    const plans = await probeRow(page, '/admin/plans');

    // A table that rendered no measurable middle cell would make the padding
    // comparisons vacuously true.
    expect(users.cellPaddingY, '/admin/users has a measurable middle cell').toBeDefined();
    expect(plans.cellPaddingY, '/admin/plans has a measurable middle cell').toBeDefined();

    expect(users.cellPaddingY, 'vertical cell padding').toBe(plans.cellPaddingY);
    // Tolerance 8px — sub-pixel rounding plus Badge vs raw text content adds up
    // to a few px even when both use the same row-height token.
    expect(
      Math.abs(users.rowHeight - plans.rowHeight),
      `row height: users ${users.rowHeight} vs plans ${plans.rowHeight}`,
    ).toBeLessThan(8);
  });

  test('Users + Plans rows agree on horizontal cell padding', async ({ page }) => {
    // Expected to fail until `/admin/users` migrates to AURA (122 phase 10):
    // the legacy kit's `--table-cell-padding-x` is 12px, AURA's cell is 16px.
    // When this starts passing, Playwright reports "expected to fail but
    // passed" — remove the annotation then, and re-read the DataTable note in
    // this file's header before trusting the number.
    test.fail();
    await signInAsSuperAdmin(page);

    const users = await probeRow(page, '/admin/users');
    const plans = await probeRow(page, '/admin/plans');

    expect(users.cellPaddingX, 'horizontal cell padding').toBe(plans.cellPaddingX);
  });

  test('Plans keeps its header row in view while the page scrolls (FR-020)', async ({ page }) => {
    await signInAsSuperAdmin(page);
    // A short window, so the plans list is longer than the viewport.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto('/admin/plans');
    const head = page.locator('thead:visible').first();
    await head.waitFor({ timeout: 15_000 });
    const before = await head.boundingBox();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    const after = await head.boundingBox();
    expect(before, 'the plans table renders a header row').not.toBeNull();
    expect(after, 'the header row is still laid out after scrolling').not.toBeNull();
    // It moved up with the page, then stopped under the top bar instead of
    // leaving the viewport.
    expect(after!.y, `header top after scrolling: ${after!.y}px`).toBeGreaterThanOrEqual(0);
    expect(after!.y).toBeLessThan(before!.y);
    expect(after!.y).toBeLessThanOrEqual(80);
  });
});
