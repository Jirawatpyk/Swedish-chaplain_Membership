/**
 * T065 — E2E: F4 SC-010 typography scale consistency.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const EXPECTED_H1_PX = 30; // 1.875rem
const EXPECTED_H2_PX = 24; // 1.5rem
const EXPECTED_H3_PX = 20; // 1.25rem
const EXPECTED_H4_PX = 18; // 1.125rem

test.describe('F4 SC-010 — typography scale @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('h1–h4 computed font-size matches FR-017 tokens', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/);

    const pages = ['/admin', '/admin/users', '/admin/plans', '/admin/settings/fees'];
    for (const path of pages) {
      await page.goto(path);
      const h1 = page.getByRole('heading', { level: 1 });
      if (await h1.count()) {
        const size = await h1
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(size, `${path} h1`).toBeCloseTo(EXPECTED_H1_PX, 0);
      }

      for (const [level, expected] of [
        [2, EXPECTED_H2_PX],
        [3, EXPECTED_H3_PX],
        [4, EXPECTED_H4_PX],
      ] as const) {
        const headings = page.getByRole('heading', { level });
        const count = await headings.count();
        for (let i = 0; i < count; i++) {
          const el = headings.nth(i);
          // Only verify headings that carry a .text-h{N} class (migrated ones).
          const hasToken = await el.evaluate((node, n) =>
            node.className.includes(`text-h${n}`), level);
          if (!hasToken) continue;
          const size = await el.evaluate((node) =>
            parseFloat(getComputedStyle(node).fontSize),
          );
          expect(size, `${path} h${level}`).toBeCloseTo(expected, 0);
        }
      }
    }
  });
});
