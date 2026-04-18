/**
 * F5 T062 / SC-007 — CLS during form-to-table container transition.
 *
 * Navigates from /admin/settings/fees (FormContainer, 42rem) to
 * /admin/members (TableContainer, 96rem) and asserts total CLS on
 * persistent chrome (sidebar, top bar, breadcrumbs) stays ≤0.02.
 */
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F5 CLS container transition @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('CLS stays ≤0.02 during form→table navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => /^\/admin(\/|$)/.test(new URL(u).pathname));

    await page.goto('/admin/settings/fees');
    await page.waitForLoadState('networkidle');

    // Start CLS observer before navigation.
    await page.evaluate(() => {
      (window as unknown as { __F5_CLS__: number }).__F5_CLS__ = 0;
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const ls = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            value?: number;
          };
          if (ls.hadRecentInput) continue;
          (window as unknown as { __F5_CLS__: number }).__F5_CLS__ += ls.value ?? 0;
        }
      });
      obs.observe({ type: 'layout-shift', buffered: true });
    });

    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    // Allow late shifts to settle.
    await page.waitForTimeout(500);

    const cls = await page.evaluate(
      () => (window as unknown as { __F5_CLS__: number }).__F5_CLS__,
    );
    expect(cls, 'CLS on persistent chrome must be ≤0.02 per SC-007').toBeLessThanOrEqual(0.02);
  });
});
