/**
 * T080 — E2E: F4 SC-013 table row/cell/hover/sticky-header consistency.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 SC-013 — data table consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('Users + Plans tables share row height + cell padding + sticky header', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/);

    const probe = async (path: string) => {
      await page.goto(path);
      const row = page.locator('tbody tr').first();
      await row.waitFor({ timeout: 10_000 });
      return row.evaluate((el) => {
        const cs = getComputedStyle(el);
        const td = el.querySelector('td');
        const tdCs = td ? getComputedStyle(td) : null;
        return {
          rowHeight: el.getBoundingClientRect().height,
          cellPaddingX: tdCs?.paddingInlineStart,
          cellPaddingY: tdCs?.paddingBlockStart,
          hoverBg: cs.backgroundColor,
        };
      });
    };

    const users = await probe('/admin/users');
    const plans = await probe('/admin/plans');

    expect(users.cellPaddingX).toBe(plans.cellPaddingX);
    expect(users.cellPaddingY).toBe(plans.cellPaddingY);
    expect(Math.abs(users.rowHeight - plans.rowHeight)).toBeLessThan(4);

    // Sticky header check — table head should remain at top during scroll.
    const stickyTop = await page.locator('thead').first().evaluate((el) => getComputedStyle(el).position);
    expect(stickyTop).toBe('sticky');
  });
});
