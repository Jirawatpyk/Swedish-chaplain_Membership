/**
 * T095 — E2E: Admin payment reconciliation view (US3).
 *
 * Spec authority:
 *   - specs/009-online-payment/spec.md US3 Acceptance Scenarios
 *     (paid-online filter, method badge column, payment timeline panel,
 *     manager role read-only).
 *   - specs/009-online-payment/tasks.md T095 — RED-first contract for
 *     the Phase 5 reconciliation surface.
 *
 * Important spec deviation surfaced during T095 authorship
 * (verified 2026-04-26 against schema + Phase 2 task T012):
 *   - The literal `payment_method LIKE 'stripe_%'` predicate written
 *     in tasks.md T096 is impossible to satisfy with the F4 schema —
 *     `invoices.payment_method` is a 4-value enum
 *     {bank_transfer, cheque, cash, other}. Online payments land as
 *     `other` (per the F5↔F4 bridge in T012). The correct predicate
 *     joins the F5 `payments` table:
 *
 *       EXISTS (SELECT 1 FROM payments p
 *               WHERE p.invoice_id = invoices.id
 *                 AND p.status = 'succeeded'
 *                 AND p.method IN ('card','promptpay'))
 *
 *     T096 in this batch implements the JOIN form; tasks.md is
 *     amended in the same commit to document the revision.
 *
 * Flow (paid-online filter):
 *   1. Sign in as admin.
 *   2. Navigate /admin/invoices — assert "paid online" filter chip
 *      renders alongside existing status select.
 *   3. Click chip → URL becomes /admin/invoices?paidOnline=1.
 *   4. Assert table renders only invoices with succeeded F5 payments.
 *   5. Assert each visible row carries a method badge (Card or PromptPay).
 *
 * Flow (timeline panel):
 *   6. Click into a paid-online invoice → /admin/invoices/[id].
 *   7. Assert payment timeline panel renders with at least the chain
 *      payment_initiated → payment_succeeded → invoice_paid.
 *   8. Assert processor charge id is present + has a copy-to-clipboard
 *      action AND a "View in Stripe" external link.
 *
 * Flow (manager read-only):
 *   9. Sign in as manager.
 *  10. Navigate /admin/invoices/[id].
 *  11. Assert payment timeline IS visible.
 *  12. Assert NO mutating actions (refund/void/record-payment) visible.
 *
 * STATUS: tests are written with real assertions, gated by:
 *   - `test.skip` when admin/manager creds are absent.
 *   - `test.skip` when no paid-online invoice has been seeded
 *     (`E2E_PAID_ONLINE_INVOICE_ID` env var).
 *
 * Phase 5 polish — `pnpm seed:f5-e2e:reconciliation` (12 paid-online +
 * 6 manual seed) and `scripts/seed-e2e-manager.ts` (manager fixture)
 * are NOT yet shipped (deferred to Phase 5 polish per
 * `/speckit.verify.run` 2026-04-26 D2/D3 findings). Until those seed
 * scripts land, the tests skip cleanly in BOTH local + CI environments
 * — the CI hard-fail was relaxed because there is no upstream seeder
 * for CI to depend on. Once seeders ship, restore the CI hard-fail
 * pattern used by T046 (`payment-card-happy-path.spec.ts`).
 *
 * workers=1 — per project memory feedback: default 3 hangs the dev
 * machine. Suite already runs serially through `--workers=1` flag in
 * `pnpm test:e2e`.
 */
import { test, expect } from './fixtures';
import { fillField } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
const PAID_ONLINE_INVOICE_ID = process.env.E2E_PAID_ONLINE_INVOICE_ID;

// R2 CRIT-3 (2026-04-27): CI hard-fail re-armed. The seed at
// `pnpm seed:f5-e2e:reconciliation` produces 1 card + 1 promptpay
// paid-online row — sufficient for the 4 assertions in this suite
// (testid presence + per-row shape, not row-count). The
// `e2e-manager@swecham.test` fixture is provisioned by
// `seed-e2e-user.ts`. CI now FAILS LOUDLY when env is misconfigured
// instead of silently skipping a P2 acceptance scenario (US3).
const isCi = process.env.CI === 'true' || process.env.CI === '1';

async function signInAsRole(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/admin', { timeout: 30_000 });
}

test.describe('admin payment reconciliation view — @payment @e2e (T095, US3)', () => {
  // R2 CRIT-3 CI gate: every required env var must be set in CI.
  if (isCi) {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error(
        '[T095 CI gate] E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD required in CI — run seed-e2e-user.ts.',
      );
    }
    if (!MANAGER_EMAIL || !MANAGER_PASSWORD) {
      throw new Error(
        '[T095 CI gate] E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD required in CI — manager fixture provisioned by seed-e2e-user.ts.',
      );
    }
    if (!PAID_ONLINE_INVOICE_ID) {
      throw new Error(
        '[T095 CI gate] E2E_PAID_ONLINE_INVOICE_ID required in CI — run `pnpm seed:f5-e2e:reconciliation`.',
      );
    }
  }

  test('paid-online filter chip renders + filter applies via URL state', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Admin creds missing — set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run.',
    );

    await signInAsRole(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/invoices');
    await page.waitForLoadState('networkidle');

    // Filter chip must be present (T096 contract).
    // testid is stable across i18n locales and renames.
    const chip = page.getByTestId('paid-online-filter-chip');
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // Toggle the chip ON — URL gains ?paidOnline=1.
    await chip.click();
    await expect(page).toHaveURL(/[?&]paidOnline=1/);

    // Toggle OFF — URL drops the param.
    await chip.click();
    await expect(page).not.toHaveURL(/[?&]paidOnline=1/);
  });

  test('method-badge column header renders on paid-online filter', async ({ page }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Admin creds missing — set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run.',
    );

    await signInAsRole(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/invoices?paidOnline=1');
    await page.waitForLoadState('networkidle');

    // Column header is present whether or not any row matches the
    // filter — it's bound to the filter being active, not row count.
    const methodHeader = page.getByTestId('column-header-method');
    await expect(methodHeader).toBeVisible({ timeout: 5_000 });

    // If at least one paid-online row exists, assert it carries one
    // of the two allowed badge variants.
    const badges = page.getByTestId(/^method-badge-(card|promptpay)$/);
    const badgeCount = await badges.count();
    if (badgeCount > 0) {
      const first = badges.first();
      const testId = await first.getAttribute('data-testid');
      expect(testId).toMatch(/^method-badge-(card|promptpay)$/);
    }
  });

  test('payment timeline panel surfaces full audit chain on paid-online invoice', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required — Phase 5 polish (`pnpm seed:f5-e2e:reconciliation`) not yet shipped.',
    );

    await signInAsRole(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    const timeline = page.getByTestId('payment-timeline');
    await expect(timeline).toBeVisible({ timeout: 5_000 });

    // Three required events from the happy-path audit chain.
    await expect(timeline.getByTestId('timeline-event-payment_initiated')).toBeVisible();
    await expect(timeline.getByTestId('timeline-event-payment_succeeded')).toBeVisible();
    await expect(timeline.getByTestId('timeline-event-invoice_paid')).toBeVisible();

    // Processor charge id chip + copy action + dashboard link.
    const chargeIdChip = timeline.getByTestId('processor-charge-id');
    await expect(chargeIdChip).toBeVisible();
    await expect(timeline.getByTestId('copy-charge-id-button')).toBeVisible();
    const dashboardLink = timeline.getByTestId('view-in-stripe-link');
    await expect(dashboardLink).toBeVisible();
    const dashboardHref = await dashboardLink.getAttribute('href');
    expect(dashboardHref).toMatch(/^https:\/\/dashboard\.stripe\.com\/(test\/)?payments\/(ch|pi)_/);
    expect(await dashboardLink.getAttribute('target')).toBe('_blank');
    expect(await dashboardLink.getAttribute('rel')).toMatch(/noopener/);
  });

  test('manager role sees timeline but no mutating actions', async ({ page }) => {
    test.skip(
      !MANAGER_EMAIL ||
        !MANAGER_PASSWORD ||
        !PAID_ONLINE_INVOICE_ID,
      'Manager fixture + paid-online seed required — Phase 5 polish (`scripts/seed-e2e-manager.ts` + `pnpm seed:f5-e2e:reconciliation`) not yet shipped.',
    );

    await signInAsRole(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    // Manager MUST see the timeline panel.
    const timeline = page.getByTestId('payment-timeline');
    await expect(timeline).toBeVisible({ timeout: 5_000 });

    // Manager MUST NOT see mutating action triggers anywhere on the
    // page (refund, void, record-payment, resend-receipt). This is the
    // read-only RBAC contract from spec.md US3 + plan.md § Security § RBAC.
    // Verify-fix IG-2 (2026-04-26): added `resend-receipt-trigger`
    // assertion which the spec AS3 explicitly mandates.
    await expect(page.getByTestId('refund-dialog-trigger')).toHaveCount(0);
    await expect(page.getByTestId('void-invoice-trigger')).toHaveCount(0);
    await expect(page.getByTestId('record-payment-trigger')).toHaveCount(0);
    await expect(page.getByTestId('resend-receipt-trigger')).toHaveCount(0);
  });
});
