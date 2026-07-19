/**
 * Gap E (2026-07-12) — Issue-refund button gate during a pending async refund.
 *
 * `computeRemainingRefundable` subtracts only `succeeded` refunds, so a
 * freshly-submitted async (pending) refund leaves the invoice re-rendering
 * with the Issue-refund button still enabled at the full balance. A second
 * click then hits the backend `refund_in_progress` guard, whose old copy
 * read like a transient glitch. The page now derives `pendingRefundExists`
 * (pending-existence, NOT subtracted from the refundable math — a pending
 * refund can still FAIL and re-open the balance) and the dialog disables the
 * trigger + shows a "settling" affordance while it is set.
 *
 * Renders against the REAL en.json so a missing settling key would surface
 * as a raw key / MISSING_MESSAGE.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(pendingRefundExists: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RefundDialog
        paymentId="pmt_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={535000n}
        currencyCode="THB"
        pendingRefundExists={pendingRefundExists}
      />
    </NextIntlClientProvider>,
  );
}

describe('RefundDialog — pending-refund gate (Gap E)', () => {
  it('disables the refund trigger and shows a settling hint when a pending refund exists', () => {
    renderDialog(true);
    const trigger = screen.getByTestId('refund-dialog-trigger');
    expect(trigger).toBeDisabled();
    // Localised settling copy resolves (never the raw i18n key).
    expect(screen.getByText('Refund settling…')).toBeInTheDocument();
    expect(
      screen.getByText(
        'A refund is settling — no action needed until it completes.',
      ),
    ).toBeInTheDocument();
    // The refund form must NOT be reachable — no amount input rendered.
    expect(screen.queryByTestId('refund-form-amount')).toBeNull();
  });

  it('renders the active, enabled refund trigger when no pending refund exists', () => {
    renderDialog(false);
    const trigger = screen.getByTestId('refund-dialog-trigger');
    expect(trigger).not.toBeDisabled();
    expect(screen.getByText('Issue refund…')).toBeInTheDocument();
    expect(screen.queryByText('Refund settling…')).toBeNull();
  });
});
