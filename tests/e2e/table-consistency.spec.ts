/**
 * T080 — E2E: F4 SC-013 table row/cell/hover/sticky-header consistency.
 */
import { expect, test } from './fixtures';
import { signInAsSuperAdmin } from './helpers/admin-session';
import { clearE2ERateLimits } from './helpers/rate-limit';

// `/admin/users` is super-admin only under RBAC v2 (`users.manage` is
// `superAdminOnly`): a plain admin gets `notFound()` and the "Page not
// available" screen, which has no table at all. This spec signed in as a
// plain admin, so the first probe never found a `tbody tr` and the test died
// before either assertion ever ran (2026-09-30). Same note as
// `layout-consistency.spec.ts`, which already reads the super-admin vars.
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe('F4 SC-013 — data table consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_SUPER_ADMIN_* not set');
  // Row height and cell padding are a desktop-table contract. Below `sm` the
  // plans table stacks into cards (spec 122 US6), so there is no `tbody tr`
  // to measure and nothing to compare against the users table.
  test.skip(({ isMobile }) => isMobile === true, 'table metrics are a desktop surface; phones get stacked cards');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('Users + Plans tables share row height + cell padding + sticky header', async ({ page }) => {
    await signInAsSuperAdmin(page);

    const probe = async (path: string) => {
      await page.goto(path);
      const row = page.locator('tbody tr').first();
      await row.waitFor({ timeout: 10_000 });
      return row.evaluate((el) => {
        const cs = getComputedStyle(el);
        // Skip cells with explicit pr-0 / pl-0 overrides (action columns
        // and checkbox columns have those for icon-button alignment).
        const td = Array.from(el.querySelectorAll('td')).find((cell) => {
          const cellCs = getComputedStyle(cell);
          return parseFloat(cellCs.paddingLeft) > 0;
        });
        const tdCs = td ? getComputedStyle(td) : null;
        return {
          rowHeight: el.getBoundingClientRect().height,
          cellPaddingX: tdCs?.paddingLeft,
          cellPaddingY: tdCs?.paddingTop,
          hoverBg: cs.backgroundColor,
        };
      });
    };

    const users = await probe('/admin/users');
    const plans = await probe('/admin/plans');

    expect(users.cellPaddingX).toBe(plans.cellPaddingX);
    expect(users.cellPaddingY).toBe(plans.cellPaddingY);
    // Tolerance 8px — sub-pixel rounding + Badge vs raw text content
    // adds up to ~5px difference even when both use the same row-height token.
    expect(Math.abs(users.rowHeight - plans.rowHeight)).toBeLessThan(8);

    // Sticky header check — table head should remain at top during scroll.
    const stickyTop = await page.locator('thead').first().evaluate((el) => getComputedStyle(el).position);
    expect(stickyTop).toBe('sticky');
  });
});
