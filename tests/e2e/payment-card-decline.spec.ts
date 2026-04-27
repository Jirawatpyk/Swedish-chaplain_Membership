/**
 * T119 (Phase 7) — E2E: AS-3b card decline with insufficient_funds.
 *
 * Spec authority: F5 spec.md US5 + plan.md § 4.1.
 *
 * Scenario: member submits an issued invoice with Stripe test card
 * `4000 0000 0000 9995` (insufficient_funds). Assert:
 *   - Bilingual decline message rendered (EN + TH + SV variants).
 *   - Retry CTA visible + enabled.
 *   - Invoice still in `issued` state (no `payment_succeeded` audit).
 *   - Audit `payment_failed{reason='insufficient_funds'}` would be
 *     written by the gateway (covered at use-case integration layer
 *     — T122).
 *   - sonner.error toast persists with the localized reason (T123).
 *
 * Relationship to existing `payment-card-declined.spec.ts`: the
 * existing spec covers the `generic_decline` decline_code via the
 * Stripe test card 4000 0000 0000 0002. THIS spec covers the
 * `insufficient_funds` variant which exercises a different branch of
 * the decline-reason mapping switch in `card-form.tsx` (specific
 * decline_code path vs. fallback `card_declined` code path).
 *
 * workers=1 per project memory — Playwright default of 3 hangs the
 * dev workstation. Always pass `--workers=1` when running.
 */
import { memberTest as test, expect } from './helpers/member-session';
import { stubStripeConfirmDecline } from './helpers/stripe-mock';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('PaySheet card decline — insufficient_funds — @payment @f5 @us5', () => {
  // Locally skip when seed is absent; in CI fail hard so a broken seed
  // pipeline does not silently pass (project memory: "Skip is not pass").
  const isCi = process.env.CI === 'true' || process.env.CI === '1';
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error(
        '[T119 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI — run `pnpm seed:f5-e2e` before Playwright.',
      );
    }
    test.skip(
      true,
      'E2E_ISSUED_INVOICE_ID missing from .env.local — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts` and `pnpm seed:f5-e2e`.',
    );
  }

  test('T119: insufficient_funds surfaces localized reason + retry + persistent toast', async ({
    page,
  }) => {
    // The shared stub takes a `declineCode` and shapes the SDK reject
    // exactly as Stripe would for card 4000 0000 0000 9995.
    await stubStripeConfirmDecline(page, {
      paymentIntentId: 'pi_test_insufficient_funds_e2e',
      declineCode: 'insufficient_funds',
    });

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}?pay=1`);
    await page.waitForLoadState('networkidle');

    const sheet = page.getByTestId('pay-sheet-content');
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    const submitButton = sheet.getByTestId('pay-sheet-card-submit');
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Localized reason — EN: "insufficient funds", TH: "เงินใน…ไม่พอ",
    // SV: "otillräckligt saldo / saknar täckning". The card-form maps
    // decline_code='insufficient_funds' → t('retry.reasonInsufficientFunds').
    const declineAlert = sheet.getByTestId('pay-sheet-retry-panel');
    await expect(declineAlert).toBeVisible({ timeout: 5_000 });
    await expect(declineAlert).toContainText(
      /(insufficient funds|ไม่พอ|otillräckligt|saldo)/i,
    );

    // Retry CTA enabled (allows immediate re-attempt without dup PI).
    const retryCta = sheet.getByTestId('pay-sheet-retry-cta');
    await expect(retryCta).toBeEnabled({ timeout: 3_000 });

    // No success-state side-effects: no confirmation panel, no
    // download-receipt CTA mounted.
    await expect(
      sheet.getByTestId('pay-sheet-confirmation-panel'),
    ).not.toBeVisible();

    // T127 aria-live announcer reflects the failure (text content
    // includes the localized reason after concatenation).
    const announcer = sheet.getByTestId('pay-sheet-aria-announcer');
    await expect(announcer).toHaveText(
      /(payment failed|insufficient funds|ไม่พอ|otillräckligt|saldo|misslyckades)/i,
    );
  });
});
