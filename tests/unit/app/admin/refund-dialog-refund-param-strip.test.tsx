/**
 * CF-3 (2026-07-12) — RefundDialog strips the `?refund=1` auto-open intent.
 *
 * The T118 command-palette path navigates to
 * `/admin/invoices/[id]?refund=1` so the dialog mounts open. Once that
 * intent is consumed into local `open` state, the param must be stripped
 * (via `router.replace`, preserving any sibling params) so a hard reload
 * does not re-open the dialog and a shared / bookmarked URL carries no
 * stale param. The strip runs on mount, so it also fires on the
 * pending-refund gate path (dialog stays closed, dead param still cleared).
 *
 * Renders against the REAL en.json so the open-dialog form copy resolves.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { RefundDialog } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog';

const replaceMock = vi.fn();
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog(opts: { search: string; pendingRefundExists?: boolean }) {
  currentSearch = opts.search;
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RefundDialog
        paymentId="pmt_1"
        invoiceId="inv_1"
        memberCompanyName="Acme AB"
        remainingRefundableSatang={535000n}
        currencyCode="THB"
        pendingRefundExists={opts.pendingRefundExists ?? false}
      />
    </NextIntlClientProvider>,
  );
}

describe('RefundDialog — ?refund=1 param strip (CF-3)', () => {
  beforeEach(() => {
    replaceMock.mockClear();
    currentSearch = '';
  });

  it('strips ?refund=1 on mount while keeping the dialog open', () => {
    renderDialog({ search: 'refund=1' });
    expect(replaceMock).toHaveBeenCalledWith('/admin/invoices/inv_1', {
      scroll: false,
    });
    // Dialog auto-opened → the refund form amount input is reachable.
    expect(screen.getByTestId('refund-form-amount')).toBeInTheDocument();
  });

  it('preserves other query params when stripping refund', () => {
    renderDialog({ search: 'refund=1&tab=activity' });
    expect(replaceMock).toHaveBeenCalledWith(
      '/admin/invoices/inv_1?tab=activity',
      { scroll: false },
    );
  });

  it('strips ?refund=1 even when a pending refund gates the dialog closed', () => {
    renderDialog({ search: 'refund=1', pendingRefundExists: true });
    expect(replaceMock).toHaveBeenCalledWith('/admin/invoices/inv_1', {
      scroll: false,
    });
    // Gate wins: settling affordance shown, refund form not reachable.
    expect(screen.getByText('Refund settling…')).toBeInTheDocument();
    expect(screen.queryByTestId('refund-form-amount')).toBeNull();
  });

  it('does not call router.replace when no ?refund param is present', () => {
    renderDialog({ search: '' });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
