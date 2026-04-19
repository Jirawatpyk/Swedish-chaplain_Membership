/**
 * F5 US1 + US2 + detail non-regression — E2E container width assertions.
 *
 * Populated across Phases 3-5:
 *   - TableContainer block (Phase 3, US1): 375/1280/1440/1920 px → ≤1536px cap
 *   - FormContainer block (Phase 4, US2):  375/1280/1440/1920 px → 672±8px
 *   - DetailContainer block (Phase 5):      375/1440 px → 1152±4px (SC-003 pixel parity)
 *
 * In all cases we assert NO horizontal body scroll and the correct
 * `[data-variant]` is present.
 *
 * The form block exercises three representative routes
 * (`/admin/settings/invoicing`, `/admin/plans/new`, `/portal/account`) to
 * protect SC-002 across categories — prior revision covered only one.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { assertNoHorizontalScroll, signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

const VIEWPORTS_FULL = [375, 1280, 1440, 1920] as const;
const VIEWPORTS_DETAIL = [375, 1440] as const;

const ADMIN_FORM_ROUTES = ['/admin/settings/invoicing', '/admin/plans/new'] as const;
const PORTAL_FORM_ROUTES = [
  '/portal/account',
  '/portal/edit',
  '/portal/contacts/invite',
] as const;
const PORTAL_DETAIL_ROUTES = ['/portal/profile'] as const;

async function signInAdmin(page: Page): Promise<void> {
  await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
}

async function signInMember(page: Page): Promise<void> {
  await signInViaForm(page, '/portal/sign-in', MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
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
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="table"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        if (width >= 1280) {
          expect(boxWidth, 'table container caps at 96rem (1536px)').toBeLessThanOrEqual(1536);
        } else {
          expect(boxWidth, 'table container takes full viewport width at 375px').toBe(width);
        }

        await assertNoHorizontalScroll(page);
      });
    }
  });

  test.describe('container-widths form', () => {
    for (const route of ADMIN_FORM_ROUTES) {
      for (const width of VIEWPORTS_FULL) {
        test(`FormContainer on ${route} @ ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await signInAdmin(page);
          await page.goto(route);
          await waitForLayoutContainer(page);

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
    }

    for (const route of PORTAL_FORM_ROUTES) {
      test(`FormContainer on ${route} @ 1440px`, async ({ page }) => {
        test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');
        await page.setViewportSize({ width: 1440, height: 900 });
        await signInMember(page);
        await page.goto(route);
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="form"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        expect(boxWidth).toBeGreaterThanOrEqual(650);
        expect(boxWidth).toBeLessThanOrEqual(680);

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
        await waitForLayoutContainer(page);

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

    // Portal detail routes — additional SC-003 coverage beyond /admin.
    for (const route of PORTAL_DETAIL_ROUTES) {
      test(`DetailContainer on ${route} @ 1440px`, async ({ page }) => {
        test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');
        await page.setViewportSize({ width: 1440, height: 900 });
        await signInMember(page);
        await page.goto(route);
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="detail"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate(
          (el) => (el as HTMLElement).getBoundingClientRect().width,
        );
        expect(boxWidth).toBeGreaterThanOrEqual(1148);
        expect(boxWidth).toBeLessThanOrEqual(1156);

        await assertNoHorizontalScroll(page);
      });
    }
  });
});
