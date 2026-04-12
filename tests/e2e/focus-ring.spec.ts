/**
 * T070 — E2E: F4 SC-011 universal focus ring on Tab across 5 pages.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const PAGES = [
  '/admin',
  '/admin/users',
  '/admin/plans',
  '/admin/plans/new',
  '/admin/settings/fees',
];

test.describe('F4 SC-011 — universal focus ring @a11y @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('Tab focus exposes ring box-shadow on every focusable element', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/);

    for (const path of PAGES) {
      await page.goto(path);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          return {
            boxShadow: cs.boxShadow,
            outlineStyle: cs.outlineStyle,
            outlineWidth: cs.outlineWidth,
          };
        });
        if (!focus) continue; // body focus — nothing to check
        const hasRing =
          (focus.boxShadow && focus.boxShadow !== 'none') ||
          (focus.outlineStyle !== 'none' && focus.outlineWidth !== '0px');
        expect(
          hasRing,
          `${path} tab#${i} must render a visible focus ring (box-shadow or outline)`,
        ).toBe(true);
      }
    }
  });
});
