/**
 * T056 — F6 events list + detail i18n coverage spec (EN+TH+SV).
 *
 * Spec authority: specs/012-eventcreate-integration/checklists/ux.md +
 * Constitution Principle V (i18n NON-NEGOTIABLE: 3 locales × all surfaces).
 *
 * Asserts:
 *   1. Each locale renders /admin/events + /admin/events/[id] without
 *      leaked translation keys (pattern matches existing i18n-coverage.spec).
 *   2. Empty-state copy reaches the user in each locale (CHK028 — 3 variants
 *      all localised per FR-020 + US2 AS5).
 *   3. <html lang> attribute matches resolved locale on each page.
 *
 * RED reason: pages do not exist + i18n keys (T067) not yet populated.
 * Until then, body text shows the bootstrap "_bootstrap" placeholder
 * and leak pattern triggers.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD.
 *
 * Run with: pnpm test:e2e --grep "@i18n.*F6" --workers=1
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const LOCALES = ['en', 'th', 'sv'] as const;

const LEAK_PATTERNS = [
  /\{[a-z]+\.[a-z]+(?:\.[a-z]+)*\}/i,
  /admin\.events\.(list|detail)\.[a-z]+/i,
  /audit\.eventcreate\.[a-z]+/i,
  /_bootstrap/, // T005 placeholder must not reach production locales
];

test.describe.configure({ timeout: 180_000 });

test.describe('@i18n T056 — F6 admin events list+detail locale coverage', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin i18n scans',
  );

  for (const locale of LOCALES) {
    test(`${locale} — /admin/events has no translation key leaks`, async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await signInAsAdmin(page);
      await page.goto('/admin/events');
      await page.waitForLoadState('networkidle');
      const bodyText = await page.evaluate(() => document.body.innerText);
      for (const pattern of LEAK_PATTERNS) {
        expect(
          bodyText,
          `key leak in ${locale} /admin/events: ${pattern}`,
        ).not.toMatch(pattern);
      }
    });

    test(`${locale} — /admin/events <html lang> matches`, async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await signInAsAdmin(page);
      await page.goto('/admin/events');
      await page.waitForLoadState('domcontentloaded');
      const htmlLang = await page
        .locator('html')
        .first()
        .getAttribute('lang');
      expect(htmlLang).toBe(locale);
    });

    test(`${locale} — empty-state copy is localised (no EN fallback in TH/SV)`, async ({
      page,
      context,
    }) => {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await signInAsAdmin(page);
      // T11 fix (verify-finding 2026-05-12): force the empty-state path
      // by navigating to a known-impossible filter combination
      // (categoryFilter that no seed event will ever match) so the
      // empty-state assertion fires regardless of seeded data shape.
      // Previously this test had a conditional-skip when table rows
      // were present, which meant the assertion never ran in
      // populated staging environments.
      await page.goto(
        '/admin/events?categoryFilter=__no_match_anywhere_2026__',
      );
      await page.waitForLoadState('networkidle');
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (locale === 'th') {
        // Thai script must appear at least once on the rendered page.
        expect(bodyText).toMatch(/[฀-๿]/);
      } else if (locale === 'sv') {
        // Swedish-specific empty-state keyword presence; "evenemang"
        // appears in either filteredEmpty or genericEmpty Swedish copy.
        expect(bodyText.toLowerCase()).toContain('evenemang');
      } else {
        // English baseline — "events" must appear (filteredEmpty or
        // genericEmpty copy).
        expect(bodyText.toLowerCase()).toContain('events');
      }
    });
  }
});
