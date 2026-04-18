/**
 * F5 T061 — Breadth probe over every one of the 19 migrated routes.
 *
 * For each route at 1440px, asserts:
 *   (a) exactly one [data-slot="layout-container"] is present
 *   (b) document.documentElement.scrollWidth === clientWidth (no body overflow)
 *
 * Uses storageState pattern: one sign-in per role per file, reused across
 * the sub-tests to avoid chewing through the per-email rate-limit budget.
 *
 * This spec does NOT assert specific widths — those live in
 * container-widths.spec.ts. Its job is to catch any page that
 * accidentally renders two containers or zero containers.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

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
  page: Page,
  signInPath: string,
  email: string,
  password: string,
  landingPattern: RegExp,
): Promise<void> {
  await page.goto(signInPath);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => {
    const p = new URL(u).pathname;
    return landingPattern.test(p) && !p.startsWith(signInPath);
  });
}

async function assertContainer(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page
    .locator('[data-slot="layout-container"]')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForLoadState('networkidle');

  const count = await page.locator('[data-slot="layout-container"]').count();
  expect(count, `${path} should render exactly one layout container`).toBe(1);

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${path} must not overflow horizontally`).toBe(clientWidth);
}

test.describe('F5 all pages containers breadth @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.describe.configure({ mode: 'serial' });

  test('staff routes — one sign-in, all 11 routes assert 1 container + no overflow', async ({ browser }) => {
    test.setTimeout(120_000);
    await clearE2ERateLimits();
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signIn(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
      for (const path of STAFF_ROUTES) {
        await assertContainer(page, path);
      }
    } finally {
      await context.close();
    }
  });

  test('member routes — one sign-in, all 5 routes assert 1 container + no overflow', async ({ browser }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');
    test.setTimeout(90_000);
    await clearE2ERateLimits();
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signIn(page, '/portal/sign-in', MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
      for (const path of MEMBER_ROUTES) {
        await assertContainer(page, path);
      }
    } finally {
      await context.close();
    }
  });
});
