/**
 * T121 (Phase 7) — E2E: stale-invoice auto-refund.
 *
 * Spec authority: F5 spec.md US5, FR-011b, plan.md § 4.1, audit
 * `payment_auto_refunded_stale_invoice`.
 *
 * Scenario: member is mid-flight on payment for invoice X. Admin
 * voids invoice X via the F4 path BEFORE the customer's payment
 * settles. The Stripe `payment_intent.succeeded` webhook arrives at
 * our server. The `confirmPayment` use-case detects the invoice is
 * no longer payable and triggers an auto-refund via the gateway.
 * Audit `payment_auto_refunded_stale_invoice` is appended.
 *
 * E2E coverage scope:
 *   - Member sees a localized "payment refunded — invoice voided"
 *     message on the next page-render (after webhook + revalidate).
 *   - Admin invoice timeline shows the auto-refund event.
 *
 * STATUS: test.fixme — this E2E requires:
 *   (a) admin void endpoint wired to the F4 invoicing module
 *   (b) Stripe webhook driver in test that can be triggered manually
 *       (CLI listen + `stripe trigger` or local webhook injector)
 *   (c) member-side notification surface for refund-after-payment
 *
 * Equivalent coverage exists at the use-case unit layer
 * (tests/unit/payments/application/confirm-payment.test.ts) and
 * the integration layer (T122 tests/integration/payments/
 * stale-invoice-auto-refund.test.ts).
 *
 * workers=1 per project memory.
 */
import { memberTest as test, expect } from './helpers/member-session';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('PaySheet stale-invoice auto-refund — @payment @f5 @us5', () => {
  test.fixme(
    true,
    'T121 requires admin-void wired + Stripe webhook trigger harness + member refund-notification surface. Equivalent coverage at unit + integration layers (T122).',
  );

  test('T121: mid-flight payment + admin voids invoice → settle webhook → auto-refund + audit', async ({
    page,
  }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}?pay=1`);
    await expect(page.getByTestId('pay-sheet-content')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('pay-sheet-card-submit').click();
    // Admin voids invoice (separate driver) → settle webhook arrives →
    // auto-refund flow → member refund-notification banner appears.
    await expect(
      page.getByText(/refund.*invoice voided|คืนเงิน|återbetal/i),
    ).toBeVisible({ timeout: 30_000 });
  });
});
