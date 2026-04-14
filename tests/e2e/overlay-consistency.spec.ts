/**
 * T085 — E2E: F4 SC-014 overlay consistency (Card, Dialog, DropdownMenu).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 SC-014 — overlay consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('Cards across pages share --card-padding (24px) + --card-radius', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    const measure = async (path: string) => {
      await page.goto(path);
      const card = page.locator('[data-slot="card"]').first();
      await card.waitFor();
      return card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          paddingBlockStart: cs.paddingBlockStart,
          paddingBlockEnd: cs.paddingBlockEnd,
          paddingInlineStart: cs.paddingInlineStart,
          paddingInlineEnd: cs.paddingInlineEnd,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
        };
      });
    };

    const dashboard = await measure('/admin');
    const users = await measure('/admin/users');
    const plans = await measure('/admin/plans');

    // All three cards must compute identical padding on every side (block + inline).
    for (const m of [dashboard, users, plans]) {
      expect(m.paddingBlockStart).toBe(dashboard.paddingBlockStart);
      expect(m.paddingBlockEnd).toBe(dashboard.paddingBlockEnd);
      expect(m.paddingInlineStart).toBe(dashboard.paddingInlineStart);
      expect(m.paddingInlineEnd).toBe(dashboard.paddingInlineEnd);
    }

    expect(dashboard.borderRadius).toBe(users.borderRadius);
    expect(dashboard.borderRadius).toBe(plans.borderRadius);
    expect(dashboard.boxShadow).not.toBe('none');
  });
});
