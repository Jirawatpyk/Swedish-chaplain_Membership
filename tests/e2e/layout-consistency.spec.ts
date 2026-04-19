/**
 * T064 (rewritten for F5) — E2E layout consistency across admin + portal pages.
 *
 * Per-category width assertions based on Content-Type Mapping:
 *   - [data-variant="table"]  → ≤ 1536px (96rem cap)
 *   - [data-variant="detail"] → 1152±4px (72rem pixel parity)
 *   - [data-variant="form"]   → 672±8px  (42rem)
 *
 * Also asserts every page has a h1 with font-size 30px (F4 typography scale).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

type Variant = 'table' | 'detail' | 'form';

const PAGES: Array<{ path: string; variant: Variant }> = [
  { path: '/admin', variant: 'detail' },
  { path: '/admin/account', variant: 'form' },
  { path: '/admin/users', variant: 'table' },
  { path: '/admin/plans', variant: 'table' },
  { path: '/admin/plans/new', variant: 'form' },
  { path: '/admin/plans/clone', variant: 'form' },
  { path: `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`, variant: 'detail' },
  { path: `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}/edit`, variant: 'form' },
  { path: '/admin/settings/invoicing', variant: 'form' },
];

const EXPECTED_H1_FONT_SIZE = '30px';

function rangeFor(variant: Variant): [number, number] {
  switch (variant) {
    case 'table':
      return [0, 1536];
    case 'detail':
      return [1148, 1156];
    case 'form':
      return [664, 680];
  }
}

test.describe('F5 layout consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every admin page applies the correct container variant at 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    });

    for (const { path, variant } of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1, `${path} has h1`).toBeVisible();
      const fontSize = await h1.evaluate((el) => getComputedStyle(el).fontSize);
      expect(fontSize, `${path} h1 font-size`).toBe(EXPECTED_H1_FONT_SIZE);

      const container = page
        .locator(`[data-slot="layout-container"][data-variant="${variant}"]`)
        .first();
      await expect(container, `${path} has ${variant} container`).toBeVisible();

      const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
      const [lo, hi] = rangeFor(variant);
      expect(boxWidth, `${path} ${variant} container width must be in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
      expect(boxWidth, `${path} ${variant} container width must be in [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
    }
  });
});
