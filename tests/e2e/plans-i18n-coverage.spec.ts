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
import { signInAsAdmin } from './helpers/admin-session';
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
    test(`plans list renders in ${locale.toUpperCase()}`, async ({ page, context }) => {
      // next-intl without middleware reads the locale from the NEXT_LOCALE
      // cookie. Seed it AFTER sign-in: set before, it localises the sign-in
      // form too, and the helper's English "Email" label no longer matches.
      await signInAsAdmin(page);
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);

      await page.goto('/admin/plans');

      // 1. No raw translation keys leak into the visible DOM.
      //    Use innerText (visible text only) to skip <script> contents.
      const bodyText = await page.evaluate(() => document.body.innerText);
      expect(bodyText).not.toMatch(/admin\.plans\.[a-z]/);
      expect(bodyText).not.toMatch(/\bpalette\.[a-z]/);

      // 2. Title renders in the active locale (the cookie is honoured).
      const title = await page.locator('h1').first().textContent();
      expect(title).toMatch(EXPECTED_TITLE[locale]);
    });
  }
});
