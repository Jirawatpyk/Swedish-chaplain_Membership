/**
 * CP-3.8 (verify-run remediation, 2026-04-21) — F4 admin surfaces
 * a11y regression scan. Complements `portal-invoices-a11y.spec.ts`
 * which covers the member-facing surfaces.
 *
 * Scans (all gated on authenticated admin session):
 *   - /admin/invoices                (list)
 *   - /admin/invoices/new            (draft form)
 *   - /admin/invoices/<seeded-id>    (detail — uses SC-2026-900002 from
 *                                     seed-e2e-portal-invoices.ts or
 *                                     falls back to first paid row)
 *   - /admin/credit-notes            (CN directory)
 *   - /admin/settings/invoicing      (tenant invoice settings)
 *
 * axe tags: WCAG 2.0 A/AA + WCAG 2.1 A/AA. Zero violations required.
 *
 * Skipped when E2E credentials or seeded-fixture flag is missing —
 * matches the existing F4 E2E spec policy.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const EXPECTS_FIXTURES =
  process.env.E2E_MEMBER_HAS_INVOICES === '1' ||
  process.env.E2E_MEMBER_HAS_INVOICES === 'true';

const STATIC_PAGES = [
  '/admin/invoices',
  '/admin/invoices/new',
  '/admin/credit-notes',
  '/admin/settings/invoicing',
] as const;

test.describe('F4 admin a11y regressions @a11y @f4', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every F4 admin static surface passes WCAG 2.1 AA', async ({ page }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );

    for (const path of STATIC_PAGES) {
      await page.goto(path);
      // Wait for the layout container so server-rendered cards
      // (InvoiceFilters, PageHeader, settings form) finish painting
      // before axe scans — otherwise it may catch an in-flight
      // skeleton state + emit false-positive landmark violations.
      await waitForLayoutContainer(page);
      await page.waitForLoadState('networkidle');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        results.violations,
        `${path} has zero WCAG 2.1 AA violations`,
      ).toEqual([]);
    }
  });

  test.skip(
    !EXPECTS_FIXTURES,
    'E2E_MEMBER_HAS_INVOICES not set — detail-page scan needs seeded invoice',
  );

  test('/admin/invoices/[invoiceId] detail passes WCAG 2.1 AA', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );

    // Navigate to the paid invoice SC-2026-900002 seeded by
    // scripts/seed-e2e-portal-invoices.ts (900000-series reserved for
    // non-mutating E2E). Falls back gracefully to "first paid row" if
    // the specific doc number isn't present in the filtered list.
    await page.goto('/admin/invoices?status=paid');
    await waitForLayoutContainer(page);
    const targetedLink = page
      .getByRole('link', { name: /SC-2026-900002/ })
      .first();
    const anyPaidLink = page.getByRole('row').first().getByRole('link').first();
    const link = (await targetedLink.count()) > 0 ? targetedLink : anyPaidLink;
    await link.waitFor({ state: 'visible', timeout: 10_000 });
    await link.click();
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      results.violations,
      '/admin/invoices/<id> has zero WCAG 2.1 AA violations',
    ).toEqual([]);
  });
});
