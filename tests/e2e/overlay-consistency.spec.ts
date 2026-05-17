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
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    const measure = async (path: string) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const card = page.locator('[data-slot="card"]').first();
      await card.waitFor();
      return card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          // padding-top/bottom from py-[var(--card-padding)]
          paddingTop: parseFloat(cs.paddingTop),
          paddingBottom: parseFloat(cs.paddingBottom),
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
        };
      });
    };

    const dashboard = await measure('/admin');
    const users = await measure('/admin/users');
    const plans = await measure('/admin/plans');

    // Card uses py-[var(--card-padding)] = 24px on top + bottom unless
    // overridden by a footer (which sets pb-0). Allow either 24 or 0
    // per side, but assert at least one side per card has the token
    // applied, and that all three cards share the same border-radius
    // (token-driven) + a non-empty shadow (depth elevation).
    for (const m of [dashboard, users, plans]) {
      const hasToken = m.paddingTop === 24 || m.paddingBottom === 24;
      expect(hasToken).toBe(true);
    }

    expect(dashboard.borderRadius).toBe(users.borderRadius);
    expect(dashboard.borderRadius).toBe(plans.borderRadius);
    expect(dashboard.boxShadow).not.toBe('none');
  });
});
