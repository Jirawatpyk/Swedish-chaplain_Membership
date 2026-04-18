/**
 * F5 T061 — Breadth probe over every one of the 19 migrated routes.
 *
 * For each route at 1440px, asserts:
 *   (a) exactly one [data-slot="layout-container"] is present
 *   (b) document.documentElement.scrollWidth === clientWidth (no body overflow)
 *
 * This spec does NOT assert specific widths — those live in
 * container-widths.spec.ts. Its job is to catch any page that
 * accidentally renders two containers or zero containers.
 */
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';
const SEEDED_MEMBER_ID = process.env.E2E_SEEDED_MEMBER_ID;

const STAFF_ROUTES = [
  '/admin',
  '/admin/account',
  '/admin/users',
  '/admin/plans',
  '/admin/plans/new',
  '/admin/plans/clone',
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`,
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}/edit`,
  '/admin/settings/fees',
  '/admin/members',
  '/admin/members/new',
];

const MEMBER_ROUTES = [
  '/portal',
  '/portal/profile',
  '/portal/account',
  '/portal/edit',
  '/portal/contacts/invite',
];

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  landingPattern: RegExp,
): Promise<void> {
  const signInPath = landingPattern.source.startsWith('^\\/admin') ? '/admin/sign-in' : '/portal/sign-in';
  await page.goto(signInPath);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => landingPattern.test(new URL(u).pathname));
}

test.describe('F5 all pages containers breadth @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  for (const path of STAFF_ROUTES) {
    test(`[staff] ${path} has exactly one layout container and no body overflow`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      const count = await page.locator('[data-slot="layout-container"]').count();
      expect(count, `${path} should render exactly one layout container`).toBe(1);

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${path} must not overflow horizontally`).toBe(clientWidth);
    });
  }

  test.describe('member routes', () => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

    for (const path of MEMBER_ROUTES) {
      test(`[member] ${path} has exactly one layout container and no body overflow`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
        await page.goto(path);
        await page.waitForLoadState('networkidle');

        const count = await page.locator('[data-slot="layout-container"]').count();
        expect(count, `${path} should render exactly one layout container`).toBe(1);

        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth, `${path} must not overflow horizontally`).toBe(clientWidth);
      });
    }
  });

  if (SEEDED_MEMBER_ID) {
    test(`[staff] /admin/members/${SEEDED_MEMBER_ID} has exactly one layout container`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
      await page.goto(`/admin/members/${SEEDED_MEMBER_ID}`);
      await page.waitForLoadState('networkidle');

      const count = await page.locator('[data-slot="layout-container"]').count();
      expect(count).toBe(1);
    });
  }
});
