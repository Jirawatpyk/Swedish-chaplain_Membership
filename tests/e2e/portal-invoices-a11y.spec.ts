/**
 * CP-5.4 (verify-run remediation, 2026-04-20) — Phase 5 portal a11y
 * regression scan. Closes the residual `[~]` on `tasks.md` CP-5.4 by
 * running axe-core WCAG 2.1 AA against the new member-facing surfaces:
 *
 *   - `/portal`              — landing page now hosts InvoicesSummaryCard
 *   - `/portal/invoices`     — list page (R7-B3)
 *
 * The invoice detail page (`/portal/invoices/[invoiceId]`) is NOT
 * scanned here because it requires a fixture-seeded invoice id; that
 * gap rolls into the Phase 10 fixture-seeded E2E batch alongside the
 * CP-5.2 byte-identical PDF assertion.
 *
 * Tagged `@a11y` so it joins the filtered run alongside other layout
 * a11y specs (members-a11y, layout-a11y, etc.).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { signInViaForm } from './helpers/layout';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

const PAGES = ['/portal', '/portal/invoices'] as const;

test.describe('F4 Phase 5 — portal a11y regressions @a11y @f4', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every Phase-5 member surface passes WCAG 2.1 AA', async ({ page }) => {
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    for (const path of PAGES) {
      await page.goto(path);
      // Settle network so server-rendered cards finish painting before
      // axe runs — otherwise axe may scan an in-flight skeleton state.
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
});
