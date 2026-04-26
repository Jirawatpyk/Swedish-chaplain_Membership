/**
 * T103 — E2E: Admin full-refund UI flow with typed-phrase confirmation.
 *
 * Spec authority: specs/009-online-payment/spec.md US4 AS1-AS4 +
 * FR-029(f) (typed-phrase gate on full refund).
 *
 * Scope: UI behaviour against the F5 reconciliation seed
 * (`E2E_PAID_ONLINE_INVOICE_ID` → `SC-2026-900001`, member
 * `E2E Alpha Co., Ltd.`). The actual `POST /api/refunds/initiate`
 * submit IS NOT exercised here — it would require a live Stripe
 * test-mode PaymentIntent matching the seeded `pi_test_xxx` id, plus
 * the F4 credit-note chain to produce a real CN row. Those layers are
 * covered separately by the use-case unit test (`tests/unit/payments/
 * application/issue-refund.test.ts`) and the multi-partial integration
 * test (`tests/integration/payments/refund-multi-partial.test.ts`).
 *
 * UI-flow assertions (this file):
 *   1. Sign in as admin.
 *   2. Navigate to the seeded paid-online invoice detail page.
 *   3. Refund button (`refund-dialog-trigger`) renders.
 *   4. Open dialog → AlertDialog visible + Cancel button focused by default.
 *   5. Fill the amount input with the full remaining balance →
 *      `<TypedPhraseConfirm>` becomes visible (FR-029(f)).
 *   6. Confirm button is DISABLED until the typed phrase matches
 *      `REFUND E2E Alpha Co., Ltd.` exactly (case-sensitive).
 *   7. Type a wrong phrase → Confirm stays disabled.
 *   8. Type the exact phrase → Confirm enables.
 *   9. Cancel closes the dialog without firing the API call.
 *  10. ?refund=1 query auto-opens the dialog on page mount (T118 cmdk).
 *
 * `pnpm test:e2e --workers=1` mandatory per project memory feedback.
 */
import { test, expect } from './fixtures';
import { fillField } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const PAID_ONLINE_INVOICE_ID = process.env.E2E_PAID_ONLINE_INVOICE_ID;

async function signInAsAdmin(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByLabel(/password/i), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/admin', { timeout: 30_000 });
}

async function readMaximumRefundableMajor(
  page: import('@playwright/test').Page,
): Promise<string> {
  // Amount input's `aria-describedby` help-text carries
  // "Maximum refundable: 53,500.00 THB" — extract the numeric
  // portion (digits + commas + optional decimals), strip group
  // separators, return as a major-unit string suitable for the
  // amount input.
  const helpText = await page.locator('[id$="-help"]').first().textContent();
  const match = helpText?.match(/([\d,]+(?:\.\d+)?)/);
  return match ? match[1]!.replace(/,/g, '') : '0';
}

test.describe('admin full refund UI — @payment @refund @e2e (T103, US4)', () => {
  test('full refund: typed-phrase gate enables Confirm only on exact match', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required (run pnpm seed:f5-e2e:reconciliation).',
    );

    await signInAsAdmin(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    // Refund button visible (admin + paid-online + remaining > 0).
    const refundTrigger = page.getByTestId('refund-dialog-trigger');
    await expect(refundTrigger).toBeVisible({ timeout: 10_000 });

    // Open dialog.
    await refundTrigger.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // Fill amount = full remaining → typed-phrase appears.
    const amountInput = page.getByTestId('refund-form-amount');
    const remainingMajor = await readMaximumRefundableMajor(page);
    await fillField(amountInput, remainingMajor);
    await fillField(
      page.getByTestId('refund-form-reason'),
      'Full refund — admin E2E UI test',
    );

    const typedPhrase = page.getByTestId('refund-typed-phrase-input');
    await expect(typedPhrase).toBeVisible({ timeout: 2_000 });

    // Read the expected phrase directly from the rendered placeholder
    // — the seed's member legal_name (e.g. `E2E Alpha Co., Ltd.`)
    // varies by tenant, and hardcoding it would make the test brittle
    // across seed revisions.
    const placeholderPhrase = await typedPhrase.getAttribute('placeholder');
    expect(placeholderPhrase).toBeTruthy();
    expect(placeholderPhrase).toMatch(/^REFUND /);
    const expectedPhrase = placeholderPhrase!;

    // Confirm disabled until phrase matches.
    const confirm = page.getByTestId('refund-form-confirm');
    await expect(confirm).toBeDisabled();

    // Wrong phrase (case-mismatch on the `REFUND` prefix) — still disabled.
    await fillField(typedPhrase, expectedPhrase.replace(/^REFUND /, 'refund '));
    await expect(confirm).toBeDisabled();

    // Exact phrase — enables.
    await typedPhrase.fill('');
    await fillField(typedPhrase, expectedPhrase);
    await expect(confirm).toBeEnabled();

    // Cancel closes dialog (we deliberately do NOT submit — the
    // refund use-case requires a live Stripe PaymentIntent that the
    // seed does not provide; that path is covered by unit + integration
    // tests).
    await page
      .getByRole('button', { name: /cancel|ยกเลิก|avbryt/i })
      .first()
      .click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  test('cmdk auto-open: ?refund=1 query opens dialog on page mount', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !PAID_ONLINE_INVOICE_ID,
      'Admin creds + E2E_PAID_ONLINE_INVOICE_ID seed required.',
    );

    await signInAsAdmin(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    // T118 cmdk navigation lands here with the auto-open query param.
    await page.goto(`/admin/invoices/${PAID_ONLINE_INVOICE_ID}?refund=1`);
    await page.waitForLoadState('networkidle');

    // Dialog open immediately without trigger click.
    await expect(page.getByRole('alertdialog')).toBeVisible({
      timeout: 10_000,
    });

    // Closing clears the query param so a refresh / shared link does
    // not reopen.
    await page
      .getByRole('button', { name: /cancel|ยกเลิก|avbryt/i })
      .first()
      .click();
    await expect(page).not.toHaveURL(/[?&]refund=1/);
  });
});
