/**
 * T077 — E2E: /admin/members/[id]/edit form @f3 @a11y @i18n.
 *
 * Coverage:
 *   - Edit page renders for an existing member (resolved via the
 *     directory listing — first row's link)
 *   - WCAG 2.1 AA scan with @axe-core/playwright
 *   - i18n smoke for TH + SV (no raw translation-key leaks)
 *
 * The bundle-change-warning DIALOG itself only fires when an admin
 * re-targets a Partnership tier's `includes_corporate_plan_id`. That
 * scenario depends on tenant-specific seed data that is not present
 * in the default E2E fixture — we cover the warning use case
 * end-to-end via the integration test (T076 +
 * tests/integration/members/bundle-change-warning.test.ts) and only
 * exercise the form chrome here.
 *
 * If no member exists in the seeded directory we soft-skip with a
 * note rather than blowing up — keeps CI deterministic on a fresh
 * Neon branch.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members edit + bundle warning — F3 US3 @f3 @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    }, { timeout: 15_000 });
  }

  /**
   * Get the first member id from the directory. Returns null on
   * an empty tenant so the caller can skip gracefully.
   */
  async function firstMemberId(page: Page): Promise<string | null> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    // Walk every link inside the directory and return the first one
    // whose href matches `/admin/members/<uuid>` (excludes /new and
    // any future sub-pages).
    const hrefs = await page
      .locator('a[href^="/admin/members/"]')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
      );
    for (const href of hrefs) {
      const match = /^\/admin\/members\/([0-9a-f-]{36})$/.exec(href);
      if (match) return match[1] ?? null;
    }
    return null;
  }

  test('edit form renders for an existing member', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    test.skip(memberId === null, 'No members in directory — skip edit-form test');
    await page.goto(`/admin/members/${memberId}/edit`);
    await page.waitForLoadState('networkidle');
    // Form heading or first input must be present
    await expect(page.locator('#company_name')).toBeVisible({ timeout: 10_000 });
  });

  test('@a11y — edit form has zero WCAG 2.1 AA violations', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    test.skip(memberId === null, 'No members — skip a11y on edit page');
    await page.goto(`/admin/members/${memberId}/edit`);
    await page.locator('#company_name').waitFor({ timeout: 10_000 });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n — TH + SV locales render edit form without raw key leaks', async ({
    page,
    context,
  }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    test.skip(memberId === null, 'No members — skip i18n on edit page');

    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await page.goto(`/admin/members/${memberId}/edit`);
      await page.waitForLoadState('networkidle');
      const text = await page.evaluate(() => document.body.innerText);
      expect(
        text,
        `${locale}: raw translation key leaked on edit page`,
      ).not.toMatch(/admin\.members\.(create|edit)\.[a-z]+/i);
    }
  });
});
