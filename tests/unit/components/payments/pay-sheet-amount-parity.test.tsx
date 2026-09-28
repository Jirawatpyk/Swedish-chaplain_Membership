/**
 * Pay-sheet amount parity — every amount surface inside the drawer shows the
 * SAME formatted total.
 *
 * Financial-integrity review of #443 ("tests to add"): the PromptPay panel
 * printed raw satang ("3852000 THB") for months while the order summary above
 * it read "38,520.00 THB". Each component had its own unit test, and the
 * PromptPay one fed `currency: 'thb'` while the page feeds `'THB'`, so no test
 * ever rendered the two side by side with the real prop the page passes. This
 * suite pins the cross-component invariant instead of re-testing a component.
 *
 * Strategy: render the real <PaySheetInternal> with PromptPay as the only
 * method (so it is the active tab), fake `useInitiatePayment` into the
 * PromptPay QR state, and stub the 3DS/PromptPay poll + Stripe loader so no
 * network is touched. The invoice fixture uses the exact shape the invoice
 * page passes to <PayNowButton> (`currency: 'THB'`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// Drive the PromptPay initiate straight to a QR; the card initiate is never
// enabled because card is not an enabled method here.
vi.mock(
  '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/use-initiate-payment',
  () => ({
    useInitiatePayment: (opts: {
      enabled: boolean;
      method?: string;
      onSuccess: (payload: unknown) => void;
    }) => {
      const { enabled, method, onSuccess } = opts;
      useEffect(() => {
        if (!enabled || method !== 'promptpay') return;
        onSuccess({
          payment: { id: 'pay_1' },
          stripe: {
            clientSecret: 'pi_parity_secret',
            publishableKey: 'pk_test_fake',
            paymentIntentId: 'pi_parity',
            promptpayQrSvgUrl: 'https://qr.stripe.com/v1/parity.svg',
            promptpayQrExpirySeconds: 900,
          },
        });
        // Fire once per enable — the QR state disables the hook afterwards.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, method]);
    },
  }),
);
vi.mock('@/hooks/use-three-d-secure-poll', () => ({ useThreeDSecurePoll: () => undefined }));
vi.mock(
  '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/stripe-cache',
  () => ({ getStripeInstance: async () => null }),
);

import { PaySheetInternal } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal';

afterEach(() => cleanup());

function renderQrState(amountDue: number) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PaySheetInternal
        // Same shape + currency casing the invoice page hands PayNowButton.
        invoice={{
          id: 'inv_parity',
          invoiceNumber: 'SC-2026-000045',
          amountDue,
          currency: 'THB',
        }}
        enabledMethods={['promptpay']}
        tenantPublishableKey="pk_test_fake"
      />
    </NextIntlClientProvider>,
  );
}

describe('<PaySheetInternal> — PromptPay amount matches the order summary', () => {
  it.each([3_852_000, 107_000, 5_350_050])(
    'amountDue=%i satang → the QR panel and the summary show the same formatted total',
    (amountDue) => {
      // The faked initiate resolves inside the mount effects, so the QR panel
      // is already in the DOM after render() — no async wait (a findBy poll
      // races the panel's countdown interval).
      renderQrState(amountDue);
      const summaryAmount = screen.getByTestId('pay-sheet-summary-amount').textContent?.trim();
      const panel = screen.getByTestId('pay-sheet-promptpay-panel');

      expect(summaryAmount).toMatch(/^[\d,]+\.\d{2} THB$/);
      expect(panel.textContent).toContain(summaryAmount);
      // The raw satang number must never reach the member.
      expect(panel.textContent).not.toContain(String(amountDue));
    },
  );
});
