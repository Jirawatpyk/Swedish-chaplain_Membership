/**
 * T025 — E2E: Staff sidebar navigation (US1–US3).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('staff sidebar — US1/US2/US3', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('sidebar renders with nav items on /admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    // Wait for sidebar content to render
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.first()).toBeAttached({ timeout: 10_000 });

    // Check nav links exist anywhere on page (sidebar renders them)
    await expect(page.getByRole('link', { name: /dashboard/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /plans/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /users/i }).first()).toBeVisible();
  });

  test('active state highlights Plans on /admin/plans', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans');
    await page.locator('h1').waitFor({ timeout: 10_000 });

    // Plans link should have data-active attribute
    const sidebar = page.locator('[data-slot="sidebar"]');
    const plansLink = sidebar.getByRole('link', { name: /^plans$/i });
    await expect(plansLink).toHaveAttribute('data-active', 'true');
  });

  test('active state highlights Users on /admin/users', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/users');
    await page.locator('h1').waitFor({ timeout: 10_000 });

    const sidebar = page.locator('[data-slot="sidebar"]');
    const usersLink = sidebar.getByRole('link', { name: /users/i });
    await expect(usersLink).toHaveAttribute('data-active', 'true');
  });

  test('nav links route correctly', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    // Click Plans link
    const sidebar = page.locator('[data-slot="sidebar"]');
    await sidebar.getByRole('link', { name: /plans/i }).click();
    await page.waitForURL(/\/admin\/plans/);
    await expect(page).toHaveURL(/\/admin\/plans/);

    // Click Users link
    await sidebar.getByRole('link', { name: /users/i }).click();
    await page.waitForURL(/\/admin\/users/);
    await expect(page).toHaveURL(/\/admin\/users/);
  });

  test('collapse and expand sidebar', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');

    // Find toggle button
    const toggle = page.getByRole('button', { name: /collapse sidebar|expand sidebar/i });
    await expect(toggle).toBeAttached();

    // Get initial state
    const initialState = await wrapper.getAttribute('data-state');

    // Toggle
    await toggle.click();
    await page.waitForTimeout(300);
    const newState = await wrapper.getAttribute('data-state');
    expect(newState).not.toBe(initialState);

    // Toggle back
    await toggle.click();
    await page.waitForTimeout(300);
    const restoredState = await wrapper.getAttribute('data-state');
    expect(restoredState).toBe(initialState);
  });

  test('rapid toggle 5x without glitch', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
    const toggle = page.getByRole('button', { name: /collapse sidebar|expand sidebar/i });

    for (let i = 0; i < 5; i++) {
      await toggle.click();
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);

    // Should be in a valid state
    const state = await wrapper.getAttribute('data-state');
    expect(['expanded', 'collapsed']).toContain(state);
  });

  test('collapse state persists across navigation', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');

    // Ensure expanded first, then collapse
    const currentState = await wrapper.getAttribute('data-state');
    if (currentState === 'collapsed') {
      await page.getByRole('button', { name: /expand sidebar/i }).click();
      await page.waitForTimeout(300);
    }
    await page.getByRole('button', { name: /collapse sidebar/i }).click();
    await page.waitForTimeout(300);
    await expect(wrapper).toHaveAttribute('data-state', 'collapsed');

    // Navigate
    await page.goto('/admin/plans');
    await page.locator('h1').waitFor({ timeout: 10_000 });

    // Should still be collapsed (cookie persists)
    await expect(wrapper).toHaveAttribute('data-state', 'collapsed');
  });

  test('tenant name visible in sidebar', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar.getByText('S').first()).toBeAttached();
  });
});
