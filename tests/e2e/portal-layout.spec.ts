/**
 * T043 — E2E: F4 US4 portal uses ContentContainer variant="portal" (64rem).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('F4 US4 — portal layout @layout', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('portal pages use 64rem max-width container', async ({ page }) => {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/portal(\/|$)/.test(p) && !p.startsWith("/portal/sign-in"); });

    for (const path of ['/portal', '/portal/account']) {
      await page.goto(path);
      const container = page
        .locator('[data-slot="content-container"][data-variant="portal"]')
        .first();
      await expect(container).toBeVisible();
      const maxWidth = await container.evaluate((el) => getComputedStyle(el).maxWidth);
      expect(maxWidth).toBe('1024px');

      const h1 = page.getByRole('heading', { level: 1 });
      await expect(h1).toBeVisible();
    }
  });
});
