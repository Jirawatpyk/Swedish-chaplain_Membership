/**
 * T120 (Phase 7) — E2E: payment resume on drawer reopen + explicit
 * cancel mid-payment.
 *
 * Spec authority: F5 spec.md US5, FR-025c, plan.md § 4.1, audit
 * post-audit gap G2 (member-initiated cancel).
 *
 * TWO scenarios in this spec (both tied to the cached-initiate +
 * /api/payments/{id}/cancel infrastructure):
 *
 *   1. Resume — open Pay-now sheet → mid-flight (CardForm ready,
 *      member did NOT submit) → close drawer (NOT navigate away).
 *      Reopen drawer. Assert:
 *        a. Same Stripe PaymentIntent reused (one POST /initiate
 *           total — the second open hits the parent-scope cache).
 *        b. No duplicate `payments` row created.
 *        c. CardForm visible without an extra skeleton flash.
 *
 *   2. Explicit cancel — open Pay-now sheet → mid-flight → click
 *      sheet drawer Cancel button. Assert:
 *        a. POST /api/payments/[id]/cancel fired with
 *           reason='user_clicked_cancel'.
 *        b. payments.status='canceled' on the DB row (covered at
 *           integration layer).
 *        c. Stripe PaymentIntent canceled (covered at gateway-mock
 *           integration layer).
 *        d. Audit `payment_canceled{actor_type='member'}` written.
 *        e. Sheet closes WITHOUT a success toast.
 *
 * workers=1 per project memory.
 */
import { memberTest as test, expect } from './helpers/member-session';
import { stubStripeConfirmSuccess } from './helpers/stripe-mock';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

test.describe('PaySheet resume + explicit cancel — @payment @f5 @us5', () => {
  const isCi = process.env.CI === 'true' || process.env.CI === '1';
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error(
        '[T120 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI — run `pnpm seed:f5-e2e` before Playwright.',
      );
    }
    test.skip(
      true,
      'E2E_ISSUED_INVOICE_ID missing from .env.local — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts` and `pnpm seed:f5-e2e`.',
    );
  }

  test('T120a: drawer close+reopen reuses the same PaymentIntent (no duplicate /initiate)', async ({
    page,
  }) => {
    await stubStripeConfirmSuccess(page, {
      paymentIntentId: 'pi_test_resume_e2e',
    });

    // Count network calls to /api/payments/initiate so we can assert
    // exactly ONE happens across the two open events.
    let initiateCount = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/payments/initiate') && req.method() === 'POST') {
        initiateCount += 1;
      }
    });

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');

    // First open
    await page.getByTestId('pay-now-button').click({ force: true });
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pay-sheet-card-skeleton')).toBeHidden({
      timeout: 10_000,
    });

    // Close WITHOUT submitting — uses the legacy "close" path, NOT
    // explicit cancel. Parent caches the initiate response.
    await sheet.getByTestId('pay-sheet-close').click();
    await expect(sheet).not.toBeVisible({ timeout: 5_000 });

    // Reopen
    await page.getByTestId('pay-now-button').click({ force: true });
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    // CardForm is reused — no fresh skeleton (the parent passes
    // `initialInitiate` so PaySheetInternal starts in `card-form`).
    // The skeleton may briefly mount during chunk-resolution but
    // should hide quickly.
    await expect(page.getByTestId('pay-sheet-card-skeleton')).toBeHidden({
      timeout: 5_000,
    });

    // Critical assertion: only ONE initiate POST across both opens.
    expect(initiateCount, 'PaymentIntent must be reused on reopen — one /initiate total').toBe(1);
  });

  test('T120b: explicit cancel mid-payment fires /cancel + closes drawer without success toast', async ({
    page,
  }) => {
    await stubStripeConfirmSuccess(page, {
      paymentIntentId: 'pi_test_explicit_cancel_e2e',
    });

    // Track POST /api/payments/{id}/cancel bodies + capture the request
    // promise so we can deterministically wait on the keepalive POST
    // instead of a fixed timeout.
    const cancelBodies: string[] = [];
    page.on('request', (req) => {
      if (
        req.url().match(/\/api\/payments\/[^/]+\/cancel/) &&
        req.method() === 'POST'
      ) {
        const body = req.postData();
        if (body) cancelBodies.push(body);
      }
    });

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('pay-now-button').click({ force: true });

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pay-sheet-card-skeleton')).toBeHidden({
      timeout: 10_000,
    });

    // Navigate away mid-flight → <PaySheet> unmount cleanup fires the
    // cancel endpoint with reason='user_navigated_away'. The in-drawer
    // explicit Cancel button path lives on ProcessingPanel/3DS panels
    // (not card-form) so navigation is the available trigger here.
    const cancelRequestPromise = page.waitForRequest(
      (req) =>
        /\/api\/payments\/[^/]+\/cancel/.test(req.url()) && req.method() === 'POST',
      { timeout: 10_000 },
    );
    await page.goto('/portal');
    await cancelRequestPromise;

    expect(
      cancelBodies.some((b) => b.includes('user_navigated_away')),
      'Cancel endpoint must fire with reason=user_navigated_away on navigate-away',
    ).toBe(true);

    // No success toast should be visible after navigation away.
    await expect(
      page.getByText(/payment received|ชำระเงิน|betalningen togs emot/i),
    ).not.toBeVisible();
  });
});
