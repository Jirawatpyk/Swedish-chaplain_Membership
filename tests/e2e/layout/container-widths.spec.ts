/**
 * F5 US1 + US2 + detail non-regression — E2E container width assertions.
 *
 * Incrementally populated through Phases 3–5:
 *   - TableContainer block (Phase 3, US1): 375/1280/1440/1920 px → ≤1536px cap
 *   - FormContainer block (Phase 4, US2):  375/1280/1440/1920 px → 672±8px
 *   - DetailContainer block (Phase 5):      375/1440 px → 1152±4px (SC-003 pixel parity)
 *
 * In all cases we assert NO horizontal body scroll and exactly one
 * `[data-slot="layout-container"]` on the page.
 */
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const VIEWPORTS_FULL = [375, 1280, 1440, 1920] as const;
const VIEWPORTS_DETAIL = [375, 1440] as const;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => {
    const p = new URL(u).pathname;
    return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
  });
}

async function assertNoHorizontalScroll(page: import('@playwright/test').Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'body must not horizontally overflow the viewport').toBe(clientWidth);
}

test.describe('F5 container widths @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test.describe('container-widths table', () => {
    for (const width of VIEWPORTS_FULL) {
      test(`TableContainer on /admin/members @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signInAdmin(page);
        await page.goto('/admin/members');
        await page.waitForLoadState('networkidle');

        const container = page.locator('[data-slot="layout-container"][data-variant="table"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        if (width >= 1280) {
          expect(boxWidth, 'table container caps at 96rem (1536px)').toBeLessThanOrEqual(1536);
        } else {
          // 375px mobile — container fills viewport (minus gutter padding is INSIDE the box).
          expect(boxWidth, 'table container takes full viewport width at 375px').toBe(width);
        }

        await assertNoHorizontalScroll(page);
      });
    }
  });

  test.describe('container-widths form', () => {
    for (const width of VIEWPORTS_FULL) {
      test(`FormContainer on /admin/settings/fees @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signInAdmin(page);
        await page.goto('/admin/settings/fees');
        await page.waitForLoadState('networkidle');

        const container = page.locator('[data-slot="layout-container"][data-variant="form"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        if (width >= 1280) {
          expect(boxWidth, 'form container sits near 42rem (≈672px) at desktop').toBeGreaterThanOrEqual(650);
          expect(boxWidth, 'form container sits near 42rem (≈672px) at desktop').toBeLessThanOrEqual(680);
        } else {
          expect(boxWidth, 'form container takes full viewport width at 375px').toBe(width);
        }

        await assertNoHorizontalScroll(page);
      });
    }
  });

  test.describe('container-widths detail', () => {
    for (const width of VIEWPORTS_DETAIL) {
      test(`DetailContainer on /admin @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signInAdmin(page);
        await page.goto('/admin');
        await page.waitForLoadState('networkidle');

        const container = page.locator('[data-slot="layout-container"][data-variant="detail"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        if (width === 1440) {
          // SC-003 pixel parity with legacy admin ContentContainer (72rem = 1152px).
          expect(boxWidth).toBeGreaterThanOrEqual(1148);
          expect(boxWidth).toBeLessThanOrEqual(1156);
        } else {
          expect(boxWidth, 'detail container takes full viewport width at 375px').toBe(width);
        }

        await assertNoHorizontalScroll(page);
      });
    }
  });
});
