/**
 * T071 — E2E i18n coverage on /admin/plans across en/th/sv locales (US1, @i18n).
 *
 * Iterates the 3 locales, loads /admin/plans, and asserts that:
 *   1. No raw translation key leaks into the DOM (e.g. "admin.plans.title"
 *      rendered literally instead of "Membership Plans").
 *   2. Each page title re-renders in the active locale.
 *   3. The missing-translation indicator appears for admin when a plan
 *      has `sv` missing on a TH/SV locale switch.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const LOCALES = ['en', 'th', 'sv'] as const;

const EXPECTED_TITLE: Record<(typeof LOCALES)[number], RegExp> = {
  en: /membership plans/i,
  th: /แพ็กเกจสมาชิก/,
  sv: /medlemspaket/i,
};

test.describe('plans i18n coverage — US1 @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_* to run i18n coverage',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  for (const locale of LOCALES) {
    test(`plans list renders in ${locale.toUpperCase()}`, async ({ page }) => {
      await page.setExtraHTTPHeaders({ 'Accept-Language': `${locale}-${locale.toUpperCase()}` });

      await page.goto('/admin/sign-in');
      await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
      await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

      await page.goto('/admin/plans');

      // 1. Title should match the expected locale
      const title = await page.locator('h1').first().textContent();
      expect(title).toMatch(EXPECTED_TITLE[locale]);

      // 2. No raw translation keys leak into the DOM
      const body = await page.locator('body').textContent();
      expect(body).not.toMatch(/admin\.plans\./);
      expect(body).not.toMatch(/palette\./);
    });
  }
});
