/**
 * T088 — E2E: PromptPay QR expiry → "QR expired — Refresh" CTA path.
 *
 * Spec authority:
 *   - specs/009-online-payment/spec.md US2 — QR expiry recovery
 *   - specs/009-online-payment/tasks.md Phase 4 T088
 *   - tenant_payment_settings.promptpay_qr_expiry_seconds (default 900s)
 *
 * Flow:
 *   1. Sign in as member; open pay sheet on PromptPay tab.
 *   2. Wait for the countdown to drain (or simulate via clock control).
 *   3. Assert "QR expired — Refresh" CTA replaces the QR <img>.
 *   4. Click Refresh → assert a new POST /api/payments/initiate fires
 *      and a fresh QR <img> renders.
 *
 * STATUS: test.fixme'd until either (a) the seed pipeline allows a
 * <60s tenant_payment_settings.promptpay_qr_expiry_seconds override,
 * or (b) we wire Playwright's clock-control + Stripe MSW fixture in
 * Phase 9. Equivalent unit coverage in
 * tests/unit/components/pay-sheet/promptpay-panel.test.tsx.
 *
 * workers=1: per project memory — default 3 hangs the dev machine.
 */
import { memberTest as test, expect } from './helpers/member-session';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('payment PromptPay expiry — @payment @e2e (T088)', () => {
  const isCi = process.env.CI === 'true' || process.env.CI === '1';
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error(
        '[T088 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI.',
      );
    }
    test.skip(true, 'E2E_ISSUED_INVOICE_ID missing.');
  }

  test('countdown reaches 0 → expired CTA → Refresh creates new attempt', async ({
    page,
  }) => {
    test.fixme(
      true,
      'Requires sub-60s expiry override + Playwright clock control. ' +
        'Phase 9 follow-up. Unit coverage in promptpay-panel.test.tsx.',
    );

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.getByTestId('pay-now-button').click({ force: true });
    await page.getByTestId('pay-sheet-tab-promptpay').click();

    // Wait for countdown to drain — in real CI this is forced via
    // Playwright clock.fastForward() + a test-only short expiry.
    const expired = page.getByTestId('pay-sheet-promptpay-expired');
    await expect(expired).toBeVisible({ timeout: 60_000 });
    await expect(expired).toHaveAttribute('aria-live', 'assertive');

    // Click Refresh — expect a new initiate fetch
    const [refreshResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/payments/initiate') &&
          r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.getByTestId('pay-sheet-promptpay-refresh').click(),
    ]);
    expect(refreshResponse.status()).toBe(201);

    // Fresh QR <img> renders again
    const qr = page.getByTestId('pay-sheet-promptpay-qr');
    await expect(qr).toBeVisible({ timeout: 5_000 });
  });
});
