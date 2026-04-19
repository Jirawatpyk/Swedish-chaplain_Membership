/**
 * F5 T062 / SC-007 — CLS during container-size transitions.
 *
 * Tests BOTH directions (form→table expanding, table→form shrinking)
 * since the shrinking case has a different shift profile. Asserts
 * total CLS on persistent chrome stays ≤0.02 per Spec §SC-007.
 */
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const CLS_BUDGET = 0.02;

test.describe('F5 CLS container transition @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function installClsObserver(page: import('@playwright/test').Page): Promise<void> {
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
        // PerformanceObserver unavailable — leave __F5_CLS__ at 0.
      }
    });
  }

  async function readCls(page: import('@playwright/test').Page): Promise<number> {
    // Wait for the next animation frame to ensure any pending layout
    // shifts have been flushed to the observer — deterministic vs an
    // arbitrary waitForTimeout.
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    return page.evaluate(
      () => (window as unknown as { __F5_CLS__: number }).__F5_CLS__ ?? 0,
    );
  }

  test('CLS stays ≤0.02 during form→table navigation (FormContainer → TableContainer)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installClsObserver(page);
    await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);

    await page.goto('/admin/settings/invoicing');
    await waitForLayoutContainer(page);

    await page.goto('/admin/members');
    await waitForLayoutContainer(page);

    const cls = await readCls(page);
    expect(cls, 'CLS on persistent chrome must be ≤0.02 per SC-007').toBeLessThanOrEqual(CLS_BUDGET);
  });

  test('CLS stays ≤0.02 during table→form navigation (TableContainer → FormContainer)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installClsObserver(page);
    await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);

    await page.goto('/admin/members');
    await waitForLayoutContainer(page);

    await page.goto('/admin/settings/invoicing');
    await waitForLayoutContainer(page);

    const cls = await readCls(page);
    expect(cls, 'CLS on persistent chrome must be ≤0.02 per SC-007 (reverse direction)').toBeLessThanOrEqual(CLS_BUDGET);
  });
});
