/**
 * T057 — E2E: F4 SC-006 CLS = 0 regression guard on sidebar toggle.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const PAGES = ['/admin', '/admin/users', '/admin/plans', '/admin/settings/invoicing'];

test.describe('F4 SC-006 — sidebar-toggle CLS @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('sidebar toggle CLS ≤ 0.01 on every migrated page', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    for (const path of PAGES) {
      await page.goto(path);
      await page.evaluate(() => {
        (window as unknown as { __cls?: number }).__cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Array<{
            value: number;
            hadRecentInput: boolean;
          }>) {
            if (!entry.hadRecentInput) {
              const w = window as unknown as { __cls?: number };
              w.__cls = (w.__cls ?? 0) + entry.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });

      // Toggle sidebar — rely on Ctrl+B keyboard shortcut from F3 or click trigger.
      await page.keyboard.press('ControlOrMeta+b');
      await page.waitForTimeout(400);
      await page.keyboard.press('ControlOrMeta+b');
      await page.waitForTimeout(400);

      const cls = await page.evaluate(
        () => (window as unknown as { __cls?: number }).__cls ?? 0,
      );
      expect(cls, `${path} CLS`).toBeLessThanOrEqual(0.01);
    }
  });
});
