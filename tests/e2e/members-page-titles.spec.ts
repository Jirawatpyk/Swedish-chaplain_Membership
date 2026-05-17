/**
 * T146a — E2E: unique <title> on every F3 route (FR-037).
 *
 * @f3 @a11y
 *
 * Navigates to every F3 admin + portal route and asserts each has a
 * non-empty, unique <title> tag per FR-037. No duplicate titles across
 * the F3 surface.
 *
 * Routes covered:
 *   /admin/members          → "Members · SweCham"
 *   /admin/members/new      → "Add member · SweCham"
 *   /admin/members/:id      → "Member · SweCham"
 *   /admin/members/:id/edit → "Edit · SweCham"
 *   /admin/members/:id/timeline → "Timeline · ... · SweCham"
 *
 * Portal routes (/portal, /portal/edit, /portal/contacts/invite) and
 * the email-change revert landing page require an active member session
 * — those titles are validated via unit-level generateMetadata tests
 * (T053a + FR-037 coverage) since E2E member login requires invitation
 * token redemption which cannot be automated without email access.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('F3 admin route page titles @f3 @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  async function firstMemberId(page: Page): Promise<string | null> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const firstRowLink = page.locator('tbody tr:first-child a').first();
    const href = await firstRowLink.getAttribute('href').catch(() => null);
    if (!href) return null;
    const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
    return match?.[1] ?? null;
  }

  test('/admin/members has title "Members · SweCham"', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title).toMatch(/members/i);
    expect(title).toMatch(/swecham/i);
  });

  test('/admin/members/new has title "Add member · SweCham"', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/members/new');
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title).toMatch(/add member/i);
    expect(title).toMatch(/swecham/i);
  });

  test('/admin/members/:id has unique member detail title', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping detail title check');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    expect(title).toMatch(/swecham/i);
    expect(title).not.toMatch(/^Members · SweCham$/); // must differ from directory title
  });

  test('/admin/members/:id/edit has unique edit title', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping edit title check');
      return;
    }
    await page.goto(`/admin/members/${memberId}/edit`);
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    expect(title).toMatch(/edit/i);
    expect(title).toMatch(/swecham/i);
  });

  test('/admin/members/:id/timeline has unique timeline title', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping timeline title check');
      return;
    }
    await page.goto(`/admin/members/${memberId}/timeline`);
    await page.waitForLoadState('networkidle');
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    expect(title).toMatch(/timeline/i);
    expect(title).toMatch(/swecham/i);
  });

  test('all collected F3 admin titles are unique', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping uniqueness check');
      return;
    }

    const routes = [
      '/admin/members',
      '/admin/members/new',
      `/admin/members/${memberId}`,
      `/admin/members/${memberId}/edit`,
      `/admin/members/${memberId}/timeline`,
    ];

    const titles: string[] = [];
    for (const route of routes) {
      const prevTitle = await page.title();
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      // In Turbopack dev, React may hoist <title> to document.title after
      // networkidle. Wait up to 3 s for the title to differ from the
      // previous page; silent catch handles same-URL re-navigation.
      await page
        .waitForFunction((prev) => document.title !== prev, prevTitle, {
          timeout: 3_000,
        })
        .catch(() => {});
      titles.push(await page.title());
    }

    const uniqueTitles = new Set(titles);
    expect(
      uniqueTitles.size,
      `Duplicate titles found: ${titles.join(' | ')}`,
    ).toBe(titles.length);
  });
});
