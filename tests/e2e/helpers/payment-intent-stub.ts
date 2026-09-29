/**
 * Shared stub for `POST /api/payments/initiate`, so a spec that only needs the
 * pay sheet's DOM does not need a real Stripe account — or a member in good
 * standing. The E2E member is lapsed by the F8 renewals seed in global setup
 * (`renewals-seed.ts`), and the real route then refuses with
 * `membership_terminated`, which leaves the card form unmounted.
 *
 * Layout and a11y assertions care about the rendered sheet, not the intent, so
 * they stub it. A spec that exercises the real payment path must NOT use this.
 *
 * The body matches `InitiateResponse` in `pay-sheet-internal.tsx`. Pair it with
 * `stubStripeConfirmSuccess` (helpers/stripe-mock.ts) when the card form itself
 * has to mount: the ids below are the ones that helper defaults to.
 */
import type { Page } from '@playwright/test';

/** The stub payment's id — also the one `/cancel` is short-circuited for. */
export const STUB_PAYMENT_ID = 'pay_test_layout';

export async function stubInitiateEndpoint(page: Page): Promise<void> {
  await page.route('**/api/payments/initiate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        payment: { id: STUB_PAYMENT_ID },
        stripe: {
          // Stripe SDK validates secret length; stub uses ≥24-char tail to satisfy regex.
          clientSecret: 'pi_3OXTestLayout00000000_secret_test000000000000000000000000',
          publishableKey: 'pk_test_layout',
          paymentIntentId: 'pi_test_layout',
          promptpayQrSvgUrl: null,
        },
        correlationId: 'test-correlation-layout',
      }),
    });
  });
  // PaySheet calls `/cancel` on close (FR-028 cancel-on-close). The stub
  // payment id does not exist in the DB, so the real route returns 400.
  // Layout-only assertions don't care about server state, so short-circuit
  // with 200 to keep the console clean.
  await page.route(`**/api/payments/${STUB_PAYMENT_ID}/cancel`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, kind: 'canceled-by-user' }),
    });
  });
}
