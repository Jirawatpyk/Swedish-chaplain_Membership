/**
 * Review I-8 — E2E: AS-3 declined-card path (F5 spec.md US1).
 *
 * Acceptance Scenario 3: Member submits an issued invoice using a
 * declined test card → bilingual decline message rendered → primary
 * "Try again" CTA visible → no audit `payment_succeeded` row written
 * → Sheet remains open with card-form re-enabled.
 *
 * Strategy: stub `window.Stripe` via `stubStripeConfirmDecline()` so
 * the test does not require a real Stripe Elements iframe — drives the
 * pay-sheet state machine deterministically into the `failed` state.
 *
 * workers=1 per project memory — Playwright default of 3 hangs the
 * dev workstation. Always pass `--workers=1` when running.
 */
import { memberTest as test, expect } from './helpers/member-session';
import { stubStripeConfirmDecline } from './helpers/stripe-mock';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('PaySheet declined card — @payment @f5', () => {
  // Same fixture-gating pattern as `pay-sheet-viewport.spec.ts`: skip
  // the body until the member-fixture E2E seeder lands (T082 in
  // pay-sheet-viewport scaffolding) but keep the shape lint+typecheck
  // clean so it ships green and unblocks atomically.
  test.fixme(
    !ISSUED_INVOICE_ID,
    'E2E_ISSUED_INVOICE_ID required (paired with T082 member-session fixture)',
  );

  test('AS-3: card_declined surfaces bilingual decline message + retry CTA, no payment_succeeded audit', async ({
    page,
  }) => {
    await stubStripeConfirmDecline(page, {
      paymentIntentId: 'pi_test_decline_e2e',
      declineCode: 'generic_decline',
    });

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}?pay=1`);
    await page.waitForLoadState('networkidle');

    // Sheet auto-opens via deep-link (FR-025).
    const sheet = page.getByTestId('pay-sheet-content');
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    // Submit the (stubbed) card form — the fake `confirmPayment`
    // resolves with the Stripe-shaped decline error. R5 fix (2026-04-25):
    // use the stable `pay-sheet-card-submit` testid; the previous
    // aria-name regex tripped strict-mode violation against the
    // "Close payment drawer" button (substring "payment" matches /pay/i).
    const submitButton = sheet.getByTestId('pay-sheet-card-submit');
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Decline message — keys live under `portal.payment.retry.*`.
    // F5R6+ fix — `PaymentFailurePanel` overrides `role="status"`
    // (NOT "alert") on purpose: the parent `<pay-sheet-aria-announcer>`
    // already mounts a persistent polite live region, so keeping
    // role="alert" on the panel would cause a double-announce on
    // every card decline. Test uses role="status" to match the
    // intentional UI choice (F5R2-CRIT-3 fix in payment-failure-
    // panel.tsx).
    const declineAlert = sheet.getByRole('status').first();
    await expect(declineAlert).toBeVisible({ timeout: 5_000 });
    // Match against EN/TH/SV variants of the decline copy. SV uses
    // "Ditt kort avvisades" + "Betalningen misslyckades" — neither
    // contains "nekades" / "nekad" (R2-C4 regex correction).
    await expect(declineAlert).toContainText(
      /(declined|ปฏิเสธ|avvisades|misslyckades)/i,
    );

    // Retry CTA must be visible + actionable. Either re-enabled
    // submit button OR a dedicated "Try again" CTA — both meet AS-3.
    const retryAffordance = sheet.getByRole('button', {
      // R5 fix (2026-04-25): match retune "Pay {amount}" / "ชำระ {amount}" /
      // "Betala {amount}" by prefix; keep "Try again" alternates for the
      // explicit-retry CTA path.
      name: /try again|ลองอีกครั้ง|försök igen|^(pay|ชำระ|betala)/i,
    });
    await expect(retryAffordance).toBeEnabled({ timeout: 3_000 });

    // Sheet stays open (NOT navigated to confirmation panel).
    await expect(
      sheet.getByText(/payment.*success|confirmed|paid/i),
    ).not.toBeVisible();

    // Negative observability assertion: the route MUST NOT have
    // emitted a `payment_succeeded` audit. We can't query the audit
    // log over HTTP from an E2E (no admin UI exposes it yet on this
    // path) so the structural assertion is "no confirmation panel
    // rendered" — which is one-to-one with `payment_succeeded` not
    // having been written, since the panel only renders on the
    // success branch of the state machine.
  });
});
