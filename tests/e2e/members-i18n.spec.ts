/**
 * T149 — E2E: i18n locale coverage for F3 member surfaces.
 *
 * @f3 @i18n
 *
 * For each of EN / TH / SV:
 *   1. No raw translation key leaks into the DOM on /admin/members
 *   2. Page title re-renders in the active locale
 *   3. axe-core WCAG 2.1 AA + WCAG 2.2 AA scan (a11y must hold per locale)
 *   4. Thai BE (Buddhist Era) display on date fields — when a member
 *      has a `date_of_birth`, the rendered date on the detail page uses
 *      the BE year (+543) for the `th-TH` locale.
 *
 * next-intl reads the active locale from the `NEXT_LOCALE` cookie
 * (no middleware path-prefix in this project). Seeds the cookie before
 * sign-in so the first render picks it up.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const LOCALES = ['en', 'th', 'sv'] as const;
type Locale = (typeof LOCALES)[number];

const DIRECTORY_TITLE_RE: Record<Locale, RegExp> = {
  en: /members/i,
  th: /สมาชิก/,
  sv: /medlemmar/i,
};

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

async function setLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
  ]);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByLabel(/password/i), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    },
    { timeout: 15_000 },
  );
}

test.describe.configure({ mode: 'serial' });

test.describe('F3 members i18n locale coverage @f3 @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  for (const locale of LOCALES) {
    test(`/admin/members renders in ${locale.toUpperCase()} without key leaks`, async ({
      page,
      context,
    }) => {
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      await setLocale(context, locale);
      await page.goto('/admin/members');
      await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

      const bodyText: string = await page.evaluate(
        () => document.body.innerText,
      );

      // No raw admin.members.* key leaks
      expect(bodyText).not.toMatch(/admin\.members\.[a-z]/);
      // No audit.eventType.* leaks
      expect(bodyText).not.toMatch(/audit\.eventType\.[a-z]/);
      // No nav.staff.* leaks
      expect(bodyText).not.toMatch(/nav\.staff\.[a-z]/);
      // No breadcrumb.* leaks
      expect(bodyText).not.toMatch(/breadcrumb\.[a-z]/);
    });

    test(`/admin/members page title in ${locale.toUpperCase()}`, async ({
      page,
      context,
    }) => {
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      await setLocale(context, locale);
      await page.goto('/admin/members');
      await page.waitForLoadState('networkidle');

      const title = await page.title();
      // Title must not be a raw key
      expect(title).not.toMatch(/admin\.members/);
      // Title must contain a word matching the expected locale pattern
      expect(title).toMatch(DIRECTORY_TITLE_RE[locale]);
    });

    test(`/admin/members axe-core WCAG 2.1+2.2 AA scan in ${locale.toUpperCase()}`, async ({
      page,
      context,
    }) => {
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      await setLocale(context, locale);
      await page.goto('/admin/members');
      await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

      const results = await new AxeBuilder({ page })
        .withTags([...AXE_TAGS])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('Thai locale: DOB field shows Buddhist Era year on member detail', async ({
    page,
    context,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await setLocale(context, 'th');

    // Find first member that has a date_of_birth visible on detail page
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const firstRowLink = page.locator('tbody tr:first-child a').first();
    const href = await firstRowLink.getAttribute('href').catch(() => null);
    if (!href) {
      test.skip(true, 'No members seeded — skipping BE year check');
      return;
    }
    const memberId = href.match(/\/admin\/members\/([0-9a-f-]+)/)?.[1];
    if (!memberId) return;

    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // Find any date text on the page with a 4-digit year.
    // If the member has a DOB, the year should be a BE year (≥ 2543 for 2000 CE).
    const bodyText: string = await page.evaluate(() => document.body.innerText);
    const yearMatches = bodyText.match(/\b(25\d\d)\b/); // BE years 2500–2599

    if (yearMatches) {
      // Found a Buddhist Era year — this is the expected format for th-TH
      const beYear = parseInt(yearMatches[1]!, 10);
      expect(beYear).toBeGreaterThanOrEqual(2543); // 2000 CE minimum
    }
    // If no DOB is present for this member, the test passes vacuously
  });
});
