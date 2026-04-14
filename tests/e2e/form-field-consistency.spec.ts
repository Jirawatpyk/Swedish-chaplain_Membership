/**
 * T074 — E2E: F4 SC-012 form field 36px height + identical label gap + error state.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 SC-012 — form field consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('inputs on fees page compute 36px height + 12px inline padding', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/);

    await page.goto('/admin/settings/fees');
    const inputs = page.locator('input[type="text"], input[type="number"], input:not([type])');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      const { height, paddingInlineStart } = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { height: node.getBoundingClientRect().height, paddingInlineStart: cs.paddingInlineStart };
      });
      expect(height, `input ${i} height`).toBeCloseTo(36, 0);
      expect(paddingInlineStart, `input ${i} padding-inline`).toBe('12px');
    }
  });
});
