/**
 * T175 — i18n coverage E2E test (spec SC-007).
 *
 * Asserts that when the user switches locale to `th` or `sv`, every
 * visible auth screen renders with NO leaked translation keys — a
 * leak would look like `{auth.signIn.title}` or `signIn.submit` in
 * the DOM and indicates a missing `en.json` → `th.json` / `sv.json`
 * mapping.
 *
 * We detect leaks by asserting the page text does not contain:
 *   - `{x.y.z}` (explicit key placeholder)
 *   - `auth.signIn.` / `auth.reset.` / `auth.invite.` / `auth.memberPortal.`
 *     substrings (translation-key prefixes that should NEVER appear
 *     as raw text in any locale)
 *
 * next-intl uses a Cookie-based locale switcher by default; we set
 * the `NEXT_LOCALE` cookie directly in Playwright context for each
 * locale under test.
 */
import { expect, test } from './fixtures';

const LOCALES = ['en', 'th', 'sv'] as const;

const PUBLIC_AUTH_PAGES = [
  '/admin/sign-in',
  '/portal/sign-in',
  '/forgot-password',
];

const LEAK_PATTERNS = [
  /\{[a-z]+\.[a-z]+(?:\.[a-z]+)*\}/i,
  /auth\.(signIn|resetPassword|forgotPassword|invite|memberPortal|changePassword|idleWarning)\.[a-z]+/i,
];

test.describe('i18n coverage across locales (T175, SC-007)', () => {
  for (const locale of LOCALES) {
    for (const path of PUBLIC_AUTH_PAGES) {
      test(`${locale} — ${path} has no untranslated key leaks`, async ({ page, context }) => {
        await context.addCookies([
          {
            name: 'NEXT_LOCALE',
            value: locale,
            url: page.url() === 'about:blank' ? 'http://localhost:3100' : page.url(),
          },
        ]);
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const bodyText = await page.evaluate(() => document.body.innerText);
        for (const pattern of LEAK_PATTERNS) {
          expect(
            bodyText,
            `translation key leaked in ${locale} ${path}: pattern=${pattern}`,
          ).not.toMatch(pattern);
        }
      });
    }
  }
});
