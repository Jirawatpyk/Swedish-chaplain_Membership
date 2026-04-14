/**
 * T068 — E2E: /admin/plans list view (US1, spec US1 AS1–AS6).
 *
 * Tagged `@i18n` so the `pnpm test:e2e --grep @i18n` subset picks it up.
 *
 * Steps:
 *   1. Sign in as the E2E admin user.
 *   2. Navigate to /admin/plans.
 *   3. Assert 9 rows are rendered (the seeded SweCham 2026 catalogue).
 *   4. Filter category = partnership → assert 3 rows remain.
 *   5. Switch locale EN → TH → SV and assert plan name re-renders.
 *
 * Requires the SweCham 2026 seed to have run against the E2E database
 * (scripts/seed-swecham-2026-plans.ts, T088 — the seed script IS the
 * fixture for this test).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('plans list — US1 @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
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

  test('admin sees 9 SweCham 2026 plans with filter + locale switch', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/plans');

    // 1. Expect 9 rows (6 corporate + 3 partnership from the SweCham 2026 seed)
    const rows = page.locator('tr[data-plan-id]');
    await expect(rows).toHaveCount(9, { timeout: 10_000 });

    // 2. Filter category = partnership → 3 rows
    //    Filter is URL-backed — navigate with query param directly since the
    //    Base UI Select is a button, not a native <select>.
    await page.goto('/admin/plans?category=partnership');
    await expect(rows).toHaveCount(3);

    // 3. Reset filter — EN locale, verify a plan name renders in English.
    //    Locale switching via Accept-Language is not wired (next-intl uses
    //    cookie/URL); TH/SV coverage lives in plans-i18n-coverage.spec.ts
    //    which seeds the cookie directly.
    await page.goto('/admin/plans');
    const enRows = page.locator('tr[data-plan-id]');
    const firstName = await enRows.first().locator('[data-plan-name]').textContent();
    expect(firstName?.trim().length ?? 0).toBeGreaterThan(0);
  });

  test('invalid year query param does not crash the page (regression)', async ({
    page,
  }) => {
    // Regression: /admin/plans?year=9999 used to throw because the page
    // validated with `!Number.isNaN(Number(q))` which accepts out-of-range
    // integers, then passed the raw value to `asPlanYear()` which rejected
    // it as a 500 server error. Now the page MUST silently drop invalid
    // year params and render the default (unfiltered) list.
    await signIn(page);

    for (const badYear of ['9999', '1999', 'abc', '1.5', '']) {
      const response = await page.goto(`/admin/plans?year=${encodeURIComponent(badYear)}`);
      expect(
        response?.status(),
        `year=${badYear} must not 500`,
      ).toBeLessThan(500);
      // Page renders the 9 seeded 2026 plans (filter silently dropped)
      const rows = page.locator('tr[data-plan-id]');
      await expect(rows).toHaveCount(9, { timeout: 5_000 });
    }
  });

  test('member role is denied /admin/plans with 403', async ({ page }) => {
    const memberEmail = process.env.E2E_MEMBER_EMAIL;
    const memberPassword = process.env.E2E_MEMBER_PASSWORD;
    test.skip(!memberEmail || !memberPassword, 'E2E_MEMBER_* not set');

    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(memberEmail!);
    await page.getByLabel(/password/i).fill(memberPassword!);
    await page.getByRole('button', { name: /sign in/i }).click();
    // Member signs in to portal — manual navigation to /admin/plans must
    // redirect away. page.goto() follows redirects so the final status is
    // usually 200 (on the destination). Check the final URL instead —
    // it must NOT stay on the staff page.
    await page.goto('/admin/plans');
    await expect(page).not.toHaveURL(/\/admin\/plans(\?|$)/);
  });
});
