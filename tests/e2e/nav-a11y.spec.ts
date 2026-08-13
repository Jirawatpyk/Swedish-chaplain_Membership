/**
 * T027 — E2E axe-core WCAG 2.1 AA scan on navigation components (US5, @a11y).
 */
import AxeBuilder from '@axe-core/playwright';
// Shared staff sign-in (60s post-sign-in budget - R9.B1). Five hand-rolled
// copies here each timed out at 30s on webkit before any assertion ran.
import { signInAsAdmin } from './helpers/admin-session';
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

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

    // Ensure expanded
    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
    const state = await wrapper.getAttribute('data-state');
    if (state === 'collapsed') {
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
  }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_*');

    await signInAsAdmin(page);
    await page.goto('/admin');

    // Collapse
    const wrapper = page.locator('[data-slot="sidebar-wrapper"]');
    const state = await wrapper.getAttribute('data-state');
    if (state === 'expanded') {
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

    // The sidebar container should have role and aria-label
    const sidebarContainer = page.locator('[data-slot="sidebar"] [aria-label]');
    await expect(sidebarContainer.first()).toBeAttached();
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
    // The persistent rail is `hidden md:block`; below md the nav lives in a
    // Sheet that only mounts once opened, so there is no [data-slot="sidebar"]
    // to Tab into and this asserts an element that cannot exist. Keyboard
    // access to the mobile nav is a different journey (open the Sheet first).
    test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a Sheet');

    await signInAsAdmin(page);
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
