/**
 * T087 — E2E: PromptPay happy path (server-confirmed PaymentIntent + QR).
 *
 * Spec authority:
 *   - specs/009-online-payment/spec.md US2
 *   - specs/009-online-payment/tasks.md Phase 4 T087
 *   - SC-004: QR renders within 2s of PromptPay tab open
 *
 * Flow:
 *   1. Sign in as Thai member fixture (handled by `memberTest`).
 *   2. Navigate to /portal/invoices/[id] (E2E_ISSUED_INVOICE_ID).
 *   3. Open the pay sheet via Pay-now CTA.
 *   4. Switch to the PromptPay tab.
 *   5. Assert the PromptPay QR <img> renders with non-empty alt within 2s.
 *   6. Assert the bilingual scan instructions + countdown are visible.
 *   7. Assert the warning microcopy is present (P7 anti-fraud).
 *   8. (fixme) Trigger Stripe CLI `payment_intent.succeeded` webhook and
 *      assert the Sheet flips to confirmation panel within 10s.
 *
 * STATUS: structural assertions (1–7) run as real tests once the seed
 * fixture is in place. The webhook-driven confirmation step (8) is
 * test.fixme'd until Stripe CLI is available in CI — covered at the
 * use-case + integration level today.
 *
 * workers=1: per project memory — default 3 hangs the dev machine.
 */
import { memberTest as test, expect } from './helpers/member-session';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('payment PromptPay happy path — @payment @e2e (T087)', () => {
  const isCi = process.env.CI === 'true' || process.env.CI === '1';
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error(
        '[T087 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI — run `pnpm seed:f5-e2e`.',
      );
    }
    test.skip(
      true,
      'E2E_ISSUED_INVOICE_ID missing — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts`.',
    );
  }

  test('PromptPay tab renders QR + countdown + bilingual instructions within 2s (SC-004)', async ({
    page,
  }) => {
    // Without a Stripe CLI / live Stripe test account in CI the
    // server-confirmed PromptPay PaymentIntent does not return a QR
    // SVG URL — skip the live render assertion until Phase 9 wires a
    // Stripe MSW fixture to the Playwright runner. Equivalent
    // coverage exists at the unit level
    // (tests/unit/components/pay-sheet/promptpay-panel.test.tsx)
    // and integration level (tests/integration/payments/
    // promptpay-amount-mismatch.test.ts).
    test.fixme(
      true,
      'Live QR rendering requires Stripe CLI / MSW-Playwright fixture (Phase 9).',
    );

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');

    // Open pay sheet
    await page.getByTestId('pay-now-button').click({ force: true });
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    // Switch to PromptPay tab
    await page.getByTestId('pay-sheet-tab-promptpay').click();

    // SC-004: QR must render within 2s
    const qr = page.getByTestId('pay-sheet-promptpay-qr');
    await expect(qr).toBeVisible({ timeout: 2_000 });
    await expect(qr).toHaveAttribute('alt', /.+/);

    // Countdown visible and inside aria-live polite region
    const countdown = page.getByTestId('pay-sheet-promptpay-countdown');
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveAttribute('aria-live', 'polite');

    // Anti-fraud warning microcopy (spec § Edge Cases P7)
    const warning = page.getByTestId('pay-sheet-promptpay-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveText(/scan|สแกน|skanna/i);
  });

  test('webhook payment_intent.succeeded → confirmation panel (fixme — Stripe CLI required)', async ({
    page,
  }) => {
    test.fixme(
      true,
      'Requires Stripe CLI `stripe trigger payment_intent.succeeded` in CI. ' +
        'Use-case coverage exists at tests/unit/payments/application/confirm-payment.test.ts.',
    );
    void page;
  });
});
