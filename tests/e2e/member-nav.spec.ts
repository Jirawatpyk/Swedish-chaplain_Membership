/**
 * 057 — E2E: member portal nav shell (desktop top-nav + mobile bottom tabs).
 * Replaces the pre-057 8-item top-nav spec.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('member nav shell — 057', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
    }, { timeout: 10_000 });
  }

  test('desktop top-nav shows the 4 destinations with visible labels', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await page.goto('/portal');
    const nav = page.getByRole('navigation', { name: /member navigation/i });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Benefits' })).toBeVisible();
  });

  test('desktop active state sets aria-current on /portal/profile', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signIn(page);
    await page.goto('/portal/profile');
    const nav = page.getByRole('navigation', { name: /member navigation/i });
    await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  });

  test('mobile bottom tabs render 5 tabs incl. Account', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/portal');
    const tabs = page.getByRole('navigation', { name: /member tab bar/i });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Account' })).toBeVisible();
    await expect(tabs.getByRole('link')).toHaveCount(5);
  });

  test('mobile Benefits tab stays active on /portal/broadcasts/**', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await page.goto('/portal/broadcasts/new');
    const tabs = page.getByRole('navigation', { name: /member tab bar/i });
    await expect(tabs.getByRole('link', { name: 'Benefits' })).toHaveAttribute('aria-current', 'page');
  });
});
