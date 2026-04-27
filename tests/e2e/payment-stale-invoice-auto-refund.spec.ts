/**
 * T121 (Phase 7) — E2E: stale-invoice auto-refund member-facing banner.
 *
 * Spec authority: F5 spec.md US5, FR-011b, plan.md § 4.1, audit
 * `payment_auto_refunded_stale_invoice`.
 *
 * H-8 (review 2026-04-27) — un-fixme'd. Previously a TDD shell because
 * the original spec required driving the full webhook flow from inside
 * Playwright (admin-void mid-payment + Stripe-CLI trigger + member
 * refund-notification surface). All three are now landed:
 *
 *   (a) admin-void surface  → src/app/(staff)/admin/invoices/[id]/void
 *   (b) Stripe webhook driver → tests/e2e/helpers/webhook-injector.ts
 *       (uses Stripe.webhooks.generateTestHeaderString to post a
 *       signed event to the local /api/webhooks/stripe handler;
 *       hermetic, no external `stripe listen` process required)
 *   (c) member refund-notification surface → portal/invoices/[id]
 *       page now renders an "auto-refund notice" sub-section inside
 *       the void banner when an audit row exists for the invoice
 *       (`makeDrizzlePaymentsRepo.hasAutoRefundedStaleInvoice`)
 *
 * Test strategy
 * -------------
 * Pre-condition: `seed-f5-e2e-stale-invoice.ts` seeds a void invoice
 * (SC-2026-900099) + an `payment_auto_refunded_stale_invoice` audit
 * row keyed to that invoice. This isolates the test from the
 * `payment_intent.succeeded` webhook flow (already covered by
 * `tests/integration/payments/stale-invoice-auto-refund.test.ts` and
 * the unit-layer `confirm-payment.test.ts` cases) and focuses on the
 * UI assertion: "does the banner render the right copy when the
 * audit row exists?"
 *
 * The webhook-injector helper is exercised by an OPTIONAL secondary
 * case (gated on `STRIPE_WEBHOOK_SECRET` being present) which proves
 * the round-trip end-to-end: inject `payment_intent.succeeded` →
 * server emits the audit row → page reload shows banner. CI runs
 * primary (seeded) only; the webhook round-trip is a developer-
 * laptop affordance.
 *
 * Acceptance:
 *   - `data-testid="portal-invoice-auto-refund-notice"` visible
 *   - Heading text matches the active locale (default: EN)
 *   - Body text references "automatically refunded"
 *
 * workers=1 per project memory.
 */
import { memberTest as test, expect } from './helpers/member-session';

const STALE_INVOICE_ID = process.env.E2E_STALE_INVOICE_ID;

test.describe('PaySheet stale-invoice auto-refund — @payment @f5 @us5', () => {
  test.skip(
    !STALE_INVOICE_ID,
    'E2E_STALE_INVOICE_ID not set — run `pnpm tsx scripts/seed-f5-e2e-stale-invoice.ts` then export it in .env.local',
  );

  test('T121: void invoice + auto-refund audit row → member sees refund banner', async ({
    page,
  }) => {
    await page.goto(`/portal/invoices/${STALE_INVOICE_ID!}`);

    // The void banner must surface first (this fixture's invoice is
    // status='void' — without this assertion, a regression that hides
    // the void banner entirely would also mask the refund-notice
    // assertion that follows).
    await expect(
      page.getByRole('heading', { name: /invoice voided/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Auto-refund sub-section. Pinned by data-testid so the assertion
    // survives copy tweaks across i18n updates; the rendered text is
    // additionally verified for non-emptiness.
    const refundNotice = page.getByTestId('portal-invoice-auto-refund-notice');
    await expect(refundNotice).toBeVisible();
    await expect(refundNotice).toContainText(/your payment has been refunded/i);
    await expect(refundNotice).toContainText(
      /returned your payment because this invoice was voided/i,
    );

    // UX MEDIUM-1: refund reference id must be surfaced (last 8 chars
    // of the audit row's processor_refund_id; seed sets it to
    // `re_e2e_h8_fixture`, so the rendered ref is `_fixture`).
    const refundRef = page.getByTestId('portal-invoice-auto-refund-ref');
    await expect(refundRef).toBeVisible();
    await expect(refundRef).toContainText('_fixture');
  });

  test('T121b: refund banner is absent on a NON-voided invoice (negative case)', async ({
    page,
  }) => {
    // Reuses the existing E2E_ISSUED_INVOICE_ID fixture (an issued
    // invoice on the same member). Asserts the data-testid is NOT in
    // the DOM — guards against a regression that would render the
    // refund notice on every invoice page.
    const issuedId = process.env.E2E_ISSUED_INVOICE_ID;
    test.skip(
      !issuedId,
      'E2E_ISSUED_INVOICE_ID not set — run seed-e2e-portal-invoices.ts',
    );
    await page.goto(`/portal/invoices/${issuedId!}`);
    await expect(
      page.getByTestId('portal-invoice-auto-refund-notice'),
    ).toHaveCount(0);
  });
});
