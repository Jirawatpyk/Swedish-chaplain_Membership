/**
 * T026 — E2E: Member portal navigation (US4).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('member nav — US4', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/portal(\/|$)/.test(p) && !p.startsWith("/portal/sign-in"); }, { timeout: 10_000 });
  }

  test('member nav renders with Dashboard and Account links', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/portal');

    // Member nav is a <nav> with aria-label containing "member"
    const nav = page.locator('nav[aria-label]').filter({ hasText: /dashboard/i });
    await expect(nav).toBeVisible();

    await expect(nav.getByRole('link', { name: /dashboard/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /account/i })).toBeVisible();
  });

  test('active state highlights Account on /portal/account', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/portal/account');

    const accountLink = page.locator('nav[aria-label]').getByRole('link', { name: /account/i });
    await expect(accountLink).toHaveClass(/bg-accent/);
  });

  test('nav links route correctly', async ({ page }) => {
    await signIn(page);
    await page.goto('/portal');

    const nav = page.locator('nav[aria-label]').filter({ hasText: /dashboard/i });

    // Click Account
    await nav.getByRole('link', { name: /account/i }).click();
    await page.waitForURL(/\/portal\/account/);
    await expect(page).toHaveURL(/\/portal\/account/);

    // Click Dashboard
    await nav.getByRole('link', { name: /dashboard/i }).click();
    await page.waitForURL(/\/portal$/);
  });
});
