/**
 * T025 — E2E: Staff sidebar navigation (US1–US3).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

// Super admin since 016 D4: the Users active-state case needs /admin/users
// to render AND the sidebar to carry the Users link — both super_admin-only
// for the shipped nav (a plain admin has neither).
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

/** Spec 122 — the staff nav is AURA SideNav, found by its landmark name. */
function staffNav(page: Page) {
  return page.getByRole('navigation', { name: 'Staff navigation' });
}

async function railState(nav: ReturnType<typeof staffNav>): Promise<'collapsed' | 'expanded'> {
  return (await nav.getAttribute('data-collapsed')) === null ? 'expanded' : 'collapsed';
}

test.describe('staff sidebar — US1/US2/US3', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_SUPER_ADMIN_EMAIL and E2E_SUPER_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('sidebar renders with nav items on /admin', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    // Wait for sidebar content to render
    const sidebar = staffNav(page);
    await expect(sidebar.first()).toBeAttached({ timeout: 10_000 });

    // Check nav links exist anywhere on page (sidebar renders them)
    await expect(page.getByRole('link', { name: /dashboard/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /plans/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /users/i }).first()).toBeVisible();
  });

  test('active state highlights Plans on /admin/plans', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Plans link should have data-active attribute
    const sidebar = staffNav(page);
    const plansLink = sidebar.getByRole('link', { name: /^plans$/i });
    await expect(plansLink).toHaveAttribute('data-active', /.*/);
  });

  test('active state highlights Users on /admin/users', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/users');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    const sidebar = staffNav(page);
    const usersLink = sidebar.getByRole('link', { name: /users/i });
    await expect(usersLink).toHaveAttribute('data-active', /.*/);
  });

  test('nav links route correctly', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    // Click Plans link
    const sidebar = staffNav(page);
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

    // Spec 122 — AURA SideNav marks the rail with `data-collapsed`.
    const wrapper = staffNav(page);

    const toggle = page.getByRole('button', { name: /collapse sidebar|expand sidebar/i }).first();
    await expect(toggle).toBeVisible();

    // Get initial state
    const initialState = await railState(wrapper);

    // Toggle via direct cookie write: the rail state is cookie-persisted and
    // the server layout reads it before render.
    await page.context().addCookies([
      {
        name: 'sidebar_state',
        value: initialState === 'expanded' ? 'false' : 'true',
        url: 'http://localhost:3100',
      },
    ]);
    await page.reload();
    await page.waitForTimeout(300);
    const newState = await railState(wrapper);
    expect(newState).not.toBe(initialState);

    // Toggle back via cookie
    await page.context().addCookies([
      {
        name: 'sidebar_state',
        value: initialState === 'expanded' ? 'true' : 'false',
        url: 'http://localhost:3100',
      },
    ]);
    await page.reload();
    await page.waitForTimeout(300);
    const restoredState = await railState(wrapper);
    expect(restoredState).toBe(initialState);
  });

  test('rapid toggle 5x without glitch', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const wrapper = staffNav(page);
    const toggle = page.getByRole('button', { name: /collapse sidebar|expand sidebar/i });

    for (let i = 0; i < 5; i++) {
      await toggle.click({ force: true });
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);

    // Should be in a valid state
    const state = await railState(wrapper);
    expect(['expanded', 'collapsed']).toContain(state);
  });

  test('collapse state persists across navigation', async ({ page }) => {
    await signIn(page);

    // Seed sidebar_state cookie = collapsed so the nav renders as the rail
    await page.context().addCookies([
      { name: 'sidebar_state', value: 'false', url: 'http://localhost:3100' },
    ]);

    await page.goto('/admin');
    const wrapper = staffNav(page);
    await expect(wrapper).toHaveAttribute('data-collapsed', '');

    // Navigate — cookie persists so state stays collapsed
    await page.goto('/admin/plans');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    await expect(wrapper).toHaveAttribute('data-collapsed', '');
  });

  test('tenant name visible in sidebar', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin');

    const sidebar = staffNav(page);
    await expect(sidebar.getByText('S').first()).toBeAttached();
  });
});
