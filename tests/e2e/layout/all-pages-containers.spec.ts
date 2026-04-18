/**
 * F5 T061 — Breadth probe over every migrated route.
 *
 * For each route at 1440px, asserts:
 *   (a) exactly one [data-slot="layout-container"] is present
 *   (b) document.documentElement.scrollWidth === clientWidth (no body overflow)
 *
 * Uses storageState pattern: one sign-in per role per mega-test, reused
 * across the route loop to avoid burning the per-email rate-limit
 * budget.
 *
 * Dynamic `[memberId]` routes are resolved from the live directory via
 * `firstActiveMemberId` helper — keeps the breadth sweep honest across
 * the full 19-route manifest instead of the 16 static paths.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import {
  assertNoHorizontalScroll,
  firstActiveMemberId,
  signInViaForm,
  waitForLayoutContainer,
} from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

// 11 static staff routes. Dynamic [memberId] routes are added at
// runtime so a seed ID doesn't need to be baked into env.
const STAFF_STATIC_ROUTES = [
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

async function assertContainer(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForLayoutContainer(page, 20_000);

  const count = await page.locator('[data-slot="layout-container"]').count();
  expect(count, `${path} should render exactly one layout container`).toBe(1);

  await assertNoHorizontalScroll(page);
}

test.describe('F5 all pages containers breadth @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.describe.configure({ mode: 'serial' });

  test('staff routes — one sign-in, all 14 routes (incl. dynamic [memberId]) assert 1 container + no overflow', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    // autoClearRateLimits fixture (imported via ../fixtures) already
    // cleared the Upstash bucket before this test ran.
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);

      // Resolve dynamic member routes from live seed data.
      let dynamicRoutes: string[] = [];
      try {
        const memberId = await firstActiveMemberId(page);
        dynamicRoutes = [
          `/admin/members/${memberId}`,
          `/admin/members/${memberId}/edit`,
          `/admin/members/${memberId}/timeline`,
        ];
      } catch (e) {
        // Seed missing — skip dynamic portion but still cover the 11 static routes.
        // Use test.info().annotations so the skip shows up in the report.
        test.info().annotations.push({
          type: 'skip',
          description: `Dynamic [memberId] routes skipped: ${(e as Error).message}`,
        });
      }

      for (const path of [...STAFF_STATIC_ROUTES, ...dynamicRoutes]) {
        await assertContainer(page, path);
        // Release per-page resources between navigations to avoid
        // net::ERR_INSUFFICIENT_RESOURCES on long sequential sweeps.
        await page.goto('about:blank');
      }
    } finally {
      await context.close();
    }
  });

  test('member routes — one sign-in, all 5 routes assert 1 container + no overflow', async ({
    browser,
  }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');
    test.setTimeout(90_000);
    // autoClearRateLimits fixture already ran.
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signInViaForm(page, '/portal/sign-in', MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
      for (const path of MEMBER_ROUTES) {
        await assertContainer(page, path);
        await page.goto('about:blank');
      }
    } finally {
      await context.close();
    }
  });
});
