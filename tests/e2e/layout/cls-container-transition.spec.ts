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
    // Exclude /admin/sign-in itself from the landing match — without
    // this, the regex matches the sign-in URL pre-redirect and the test
    // proceeds before auth completes.
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    });

    // Use addInitScript so the observer is (re)installed on every
    // navigation. A plain page.evaluate would be wiped by page.goto.
    await page.addInitScript(() => {
      (window as unknown as { __F5_CLS__: number }).__F5_CLS__ = 0;
      try {
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
      } catch {
        // PerformanceObserver may not be available in some contexts.
      }
    });

    await page.goto('/admin/settings/fees');
    await page.locator('[data-slot="layout-container"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForLoadState('networkidle');

    await page.goto('/admin/members');
    await page.locator('[data-slot="layout-container"]').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    const cls = await page.evaluate(
      () => (window as unknown as { __F5_CLS__: number }).__F5_CLS__ ?? 0,
    );
    expect(cls, 'CLS on persistent chrome must be ≤0.02 per SC-007').toBeLessThanOrEqual(0.02);
  });
});
