/**
 * F5 T061 — Breadth probe over every migrated route.
 *
 * For each route at 1440px, asserts:
 *   (a) exactly one [data-slot="layout-container"] is present
 *   (b) document.documentElement.scrollWidth === clientWidth (no body overflow)
 *
 * Three sub-tests:
 *  1. Static staff routes (always runs when E2E_ADMIN_* set)
 *  2. Dynamic [memberId] staff routes (test.skip()s if no active member
 *     in seed — uses real Playwright skip so CI reports correctly,
 *     not a cosmetic annotation)
 *  3. Member portal routes (test.skip()s when E2E_MEMBER_* unset)
 *
 * Each sub-test signs in once and reuses the browser context for all
 * its routes (storageState pattern) to avoid burning the per-email
 * rate-limit budget.
 *
 * `page.goto('about:blank')` between routes releases per-page resources
 * to work around a Chromium quirk where long sequential sweeps on the
 * same context exhaust http2 connection slots and surface as
 * `net::ERR_INSUFFICIENT_RESOURCES`. The static-vs-dynamic split also
 * caps each sub-test's route count, which mitigates the same issue.
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

const STAFF_STATIC_ROUTES = [
  '/admin',
  '/admin/account',
  '/admin/users',
  '/admin/plans',
  '/admin/plans/new',
  '/admin/plans/clone',
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`,
  `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}/edit`,
  '/admin/settings/invoicing',
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

async function sweepRoutes(
  context: BrowserContext,
  page: Page,
  routes: readonly string[],
): Promise<void> {
  for (const path of routes) {
    await assertContainer(page, path);
    await page.goto('about:blank');
  }
}

test.describe('F5 all pages containers breadth @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.describe.configure({ mode: 'serial' });

  test('staff static routes — 11 routes assert 1 container + no overflow', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
      await sweepRoutes(context, page, STAFF_STATIC_ROUTES);
    } finally {
      await context.close();
    }
  });

  test('staff dynamic [memberId] routes — 3 routes asserted against live seed', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);

      let memberId: string;
      try {
        memberId = await firstActiveMemberId(page);
      } catch (e) {
        // Real test.skip() so CI reports "skipped" not "passed".
        test.skip(
          true,
          `Seed has no active member — dynamic [memberId] routes cannot be exercised: ${(e as Error).message}`,
        );
        return;
      }

      await sweepRoutes(context, page, [
        `/admin/members/${memberId}`,
        `/admin/members/${memberId}/edit`,
        `/admin/members/${memberId}/timeline`,
      ]);
    } finally {
      await context.close();
    }
  });

  test('member portal routes — 5 routes assert 1 container + no overflow', async ({ browser }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');
    test.setTimeout(90_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await signInViaForm(page, '/portal/sign-in', MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
      await sweepRoutes(context, page, MEMBER_ROUTES);
    } finally {
      await context.close();
    }
  });
});
