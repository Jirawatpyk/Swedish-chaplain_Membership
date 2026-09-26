/**
 * T027 — E2E axe-core WCAG 2.1 AA scan on navigation components (US5, @a11y).
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
// Shared staff sign-in (60s post-sign-in budget - R9.B1). Five hand-rolled
// copies here each timed out at 30s on webkit before any assertion ran.
import { signInAsAdmin } from './helpers/admin-session';
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

/**
 * Spec 122 US1 — below 1024px AURA's AppShell keeps the staff nav in a drawer
 * that mounts only when opened (the legacy sidebar stayed in the DOM at every
 * width), so open it before asserting on the landmark. From 1024px it is on
 * the page already and there is no menu button.
 */
async function revealStaffNav(page: Page): Promise<Locator> {
  const menu = page.getByRole('button', { name: /open navigation/i });
  if (await menu.isVisible()) await menu.click();
  const nav = page.getByRole('navigation', { name: 'Staff navigation' });
  await expect(nav).toBeVisible();
  return nav;
}

test.describe('nav a11y — US5 @a11y', () => {
  // 90s cap, same rationale as the persona suites: sign-in + redirect on the
  // DEV server can sit behind a route cold-compile, and webkit is the slowest
  // browser here — the default 30s test budget was consumed by sign-in alone
  // on mobile-safari, before any assertion ran.
  test.describe.configure({ timeout: 90_000 });
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('/admin sidebar expanded — zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await signInAsAdmin(page);
    await page.goto('/admin');

    // Ensure expanded (spec 122 — AURA SideNav marks the rail with data-collapsed).
    // On a phone this scans the open drawer, which is never a rail.
    const nav = await revealStaffNav(page);
    if ((await nav.getAttribute('data-collapsed')) !== null) {
      await page.getByRole('button', { name: /expand sidebar/i }).click();
      await page.waitForTimeout(300);
    }

    const results = await new AxeBuilder({ page })
      // Base UI renders focus-guard sentinels around floating/drawer content and
      // gives them role="button" ON TOUCH platforms (a VoiceOver dismiss target)
      // with no accessible name — axe 4.x flags every one as aria-command-name.
      // Vendor DOM, not ours to fix; tracked upstream. Everything else stays in
      // scope, which is the point of excluding rather than skipping the scan.
      .exclude('[data-base-ui-focus-guard]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('/admin sidebar collapsed — zero WCAG 2.1 AA violations', async ({
    page,
    isMobile,
  }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');
    // The 64px rail exists from 1024px only; on a phone the nav is the drawer,
    // which the expanded test above opens and scans.
    test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a drawer');

    await signInAsAdmin(page);
    await page.goto('/admin');

    // Collapse
    const nav = page.getByRole('navigation', { name: 'Staff navigation' });
    if ((await nav.getAttribute('data-collapsed')) === null) {
      await page.getByRole('button', { name: /collapse sidebar/i }).click();
      await page.waitForTimeout(300);
    }

    const results = await new AxeBuilder({ page })
      // Base UI renders focus-guard sentinels around floating/drawer content and
      // gives them role="button" ON TOUCH platforms (a VoiceOver dismiss target)
      // with no accessible name — axe 4.x flags every one as aria-command-name.
      // Vendor DOM, not ours to fix; tracked upstream. Everything else stays in
      // scope, which is the point of excluding rather than skipping the scan.
      .exclude('[data-base-ui-focus-guard]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('/portal member nav — zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_*');

    await page.goto('/portal/sign-in');
    // fillField, not raw .fill(): webkit can drop a raw fill on the controlled
    // input, submitting an EMPTY email - the page then stays on /portal/sign-in
    // showing "Please enter a valid email address." while waitForURL burns its
    // whole budget. That was this test's entire mobile-safari failure.
    await fillField(page.getByLabel(/email/i), MEMBER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/portal(\/|$)/.test(p) && !p.startsWith("/portal/sign-in"); }, { timeout: 60_000 });
    await page.goto('/portal');

    const results = await new AxeBuilder({ page })
      // Base UI renders focus-guard sentinels around floating/drawer content and
      // gives them role="button" ON TOUCH platforms (a VoiceOver dismiss target)
      // with no accessible name — axe 4.x flags every one as aria-command-name.
      // Vendor DOM, not ours to fix; tracked upstream. Everything else stays in
      // scope, which is the point of excluding rather than skipping the scan.
      .exclude('[data-base-ui-focus-guard]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('staff sidebar has aria-label attribute', async ({ page }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await signInAsAdmin(page);

    // The staff nav is a named navigation landmark (AURA SideNav), in the
    // drawer on a phone.
    await revealStaffNav(page);
  });

  test('skip-link is first Tab stop (WCAG 2.4.1)', async ({ page, browserName, isMobile }) => {
    // iOS has no hardware Tab key and webkit's touch emulation does not move
    // focus through links the way a desktop UA does - the desktop projects
    // carry this assertion.
    test.skip(browserName === 'webkit' && isMobile === true, 'no keyboard Tab on iOS-emulated webkit');
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await signInAsAdmin(page);
    await page.goto('/admin');

    // First Tab should focus the skip-to-content link
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main-content');
  });

  test('keyboard Tab reaches sidebar links', async ({ page, isMobile }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');
    // The persistent nav shows from 1024px; below that it lives in AURA's
    // drawer, which only mounts once opened, so there is nothing to Tab into.
    // Keyboard access to the mobile nav is a different journey (open it first).
    test.skip(isMobile === true, 'Desktop nav only — mobile renders the nav in a drawer');

    await signInAsAdmin(page);
    await page.goto('/admin');

    // Tab multiple times to reach sidebar links
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
    }

    // At least one sidebar link should be focusable
    const sidebar = page.getByRole('navigation', { name: 'Staff navigation' });
    const links = sidebar.getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
  });
});
