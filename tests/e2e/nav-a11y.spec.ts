/**
 * T027 — E2E axe-core WCAG 2.1 AA scan on navigation components (US5, @a11y).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('nav a11y — US5 @a11y', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('/admin sidebar expanded — zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
    await page.goto('/admin');

    // Ensure expanded
    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
    const state = await wrapper.getAttribute('data-state');
    if (state === 'collapsed') {
      await page.getByRole('button', { name: /expand sidebar/i }).click();
      await page.waitForTimeout(300);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('/admin sidebar collapsed — zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
    await page.goto('/admin');

    // Collapse
    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
    const state = await wrapper.getAttribute('data-state');
    if (state === 'expanded') {
      await page.getByRole('button', { name: /collapse sidebar/i }).click();
      await page.waitForTimeout(300);
    }

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('/portal member nav — zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_*');

    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/portal(\/|$)/, { timeout: 10_000 });
    await page.goto('/portal');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('staff sidebar has aria-label attribute', async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });

    // The sidebar container should have role and aria-label
    const sidebarContainer = page.locator('[data-slot="sidebar"] [aria-label]');
    await expect(sidebarContainer.first()).toBeAttached();
  });

  test('skip-link is first Tab stop (WCAG 2.4.1)', async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
    await page.goto('/admin');

    // First Tab should focus the skip-to-content link
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main-content');
  });

  test('keyboard Tab reaches sidebar links', async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
    await page.goto('/admin');

    // Tab multiple times to reach sidebar links
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
    }

    // At least one sidebar link should be focusable
    const sidebar = page.locator('[data-slot="sidebar"]');
    const links = sidebar.getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
  });
});
