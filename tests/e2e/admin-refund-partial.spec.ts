/**
 * T104 — E2E: Admin partial-refund UI flow (no typed-phrase gate).
 *
 * Spec authority: specs/009-online-payment/spec.md US4 AS5-AS6 +
 * FR-029(f) (typed-phrase ONLY on full refund — NOT on partials).
 *
 * Scope: UI behaviour against the F5 reconciliation seed
 * (`E2E_PAID_ONLINE_INVOICE_ID`). Submit path is NOT exercised — the
 * use-case unit test + multi-partial integration test cover the
 * end-to-end behaviour. This spec verifies the partial-refund UX
 * differs from the full-refund flow exactly per FR-029(f):
 *   - Amount < remaining → typed-phrase field NOT visible.
 *   - Amount === remaining → typed-phrase field becomes visible.
 *   - Amount > remaining → zod resolver blocks (Confirm stays disabled).
 *
 * `pnpm test:e2e --workers=1` mandatory per project memory feedback.
 */
import { test, expect } from './fixtures';
import { fillField } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { readMaximumRefundableMajorNumber as readMaximumRefundableMajor } from './helpers/refund';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const PAID_ONLINE_INVOICE_ID = process.env.E2E_PAID_ONLINE_INVOICE_ID;

test.describe('admin partial refund UI — @payment @refund @e2e (T104, US4)', () => {
  test('partial amount < remaining → typed-phrase HIDDEN; Confirm enables', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required (run pnpm seed:f5-e2e:reconciliation).',
    );

    await signInAsAdmin(page);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('refund-dialog-trigger').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    // Half remaining → solidly partial.
    const remainingMajor = await readMaximumRefundableMajor(page);
    expect(remainingMajor).toBeGreaterThan(0);
    const partialMajor = (remainingMajor / 2).toFixed(2);
    await fillField(page.getByTestId('refund-form-amount'), partialMajor);
    await fillField(
      page.getByTestId('refund-form-reason'),
      'Partial refund — admin E2E UI test',
    );

    // FR-029(f): typed-phrase MUST NOT appear on partial refund.
    await expect(page.getByTestId('refund-typed-phrase-input')).toHaveCount(0);

    // RHF schema valid → Confirm enabled (no typed-phrase gate).
    await expect(page.getByTestId('refund-form-confirm')).toBeEnabled();

    // Cancel closes (no submit — Stripe path covered elsewhere).
    await page
      .getByRole('button', { name: /cancel|ยกเลิก|avbryt/i })
      .first()
      .click();
    await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 5_000 });
  });

  test('exhausting amount === remaining → typed-phrase VISIBLE; Confirm disabled until match', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required.',
    );

    await signInAsAdmin(page);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('refund-dialog-trigger').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    const remainingMajor = await readMaximumRefundableMajor(page);
    expect(remainingMajor).toBeGreaterThan(0);
    await fillField(
      page.getByTestId('refund-form-amount'),
      remainingMajor.toFixed(2),
    );
    await fillField(
      page.getByTestId('refund-form-reason'),
      'Exhausting partial — E2E',
    );

    // Crossed the full-refund threshold → typed-phrase activates.
    await expect(page.getByTestId('refund-typed-phrase-input')).toBeVisible({
      timeout: 2_000,
    });
    await expect(page.getByTestId('refund-form-confirm')).toBeDisabled();
  });

  test('amount > remaining → zod resolver blocks; Confirm stays disabled', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required.',
    );

    await signInAsAdmin(page);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    await page.getByTestId('refund-dialog-trigger').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    const remainingMajor = await readMaximumRefundableMajor(page);
    expect(remainingMajor).toBeGreaterThan(0);
    // 1.5× remaining → over-limit.
    await fillField(
      page.getByTestId('refund-form-amount'),
      (remainingMajor * 1.5).toFixed(2),
    );
    await fillField(
      page.getByTestId('refund-form-reason'),
      'Over-limit attempt — E2E',
    );

    // RHF schema rejects (amountRange refine) → Confirm disabled.
    await expect(page.getByTestId('refund-form-confirm')).toBeDisabled();
  });
});
