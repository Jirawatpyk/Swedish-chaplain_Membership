/**
 * 090-fix-portal-receipt-download — Bug 2.
 *
 * After paying ONLINE, the invoice detail page did not show the "Download
 * receipt" button until a manual refresh. The single `router.refresh()` fired
 * by <PaySheet> on payment-settled races the Stripe webhook (marks paid → mints
 * §86/4 RC → renders RC PDF async), so at refresh time the server still shows
 * `status='issued'` and the ONLY reveal mechanism (<ReceiptStatusWatcher>) was
 * gated behind `status === 'paid'`, which is never true at that moment.
 *
 * <ReceiptReveal> closes the gap: it mounts the SAME status-poll watcher during
 * the client-side optimistic-paid window (as well as the server-truth
 * paid+pending window), so the watcher polls /receipt/status and refreshes the
 * page the moment the RC PDF renders — no manual refresh. `shouldPollReceipt`
 * is the pure decision so every branch is unit-pinned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import {
  ReceiptReveal,
  shouldPollReceipt,
} from '@/app/(member)/portal/invoices/[invoiceId]/_components/receipt-reveal';

describe('shouldPollReceipt (090 Bug 2 — decision)', () => {
  const base = {
    optimisticallyPaid: false,
    receiptAvailable: false,
    receiptAsyncPending: false,
    receiptAsyncFailed: false,
  } as const;

  it('polls on the just-paid-online gap (optimistic paid, server not caught up)', () => {
    // The Bug 2 case: client knows payment succeeded, server still `issued`
    // (receipt not available, not yet pending, not failed).
    expect(shouldPollReceipt({ ...base, optimisticallyPaid: true })).toBe(true);
  });

  it('polls when the server explicitly marks the async RC render pending', () => {
    expect(shouldPollReceipt({ ...base, receiptAsyncPending: true })).toBe(true);
  });

  it('does NOT poll once the receipt download is already available (avoids a wasted refresh)', () => {
    expect(
      shouldPollReceipt({
        ...base,
        optimisticallyPaid: true,
        receiptAvailable: true,
      }),
    ).toBe(false);
  });

  it('does NOT poll on a TERMINAL render failure (page shows the support block; cron recovers)', () => {
    expect(
      shouldPollReceipt({
        ...base,
        optimisticallyPaid: true,
        receiptAsyncFailed: true,
      }),
    ).toBe(false);
  });

  it('does NOT poll for a plain unpaid/idle invoice', () => {
    expect(shouldPollReceipt(base)).toBe(false);
  });
});

// --- Wiring: the client component reads the optimistic-paid signal and mounts
// the shared watcher when the decision says poll. -------------------------
const watcherSpy = vi.fn();
vi.mock(
  '@/app/(member)/portal/invoices/_components/receipt-status-watcher',
  () => ({
    ReceiptStatusWatcher: (props: { invoiceId: string }) => {
      watcherSpy(props);
      return <div data-testid="receipt-status-watcher-stub" />;
    },
  }),
);

let optimisticValue = false;
vi.mock(
  '@/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid',
  () => ({
    useOptimisticPaid: () => optimisticValue,
  }),
);

describe('<ReceiptReveal> wiring (090 Bug 2)', () => {
  afterEach(() => {
    cleanup();
    watcherSpy.mockReset();
    optimisticValue = false;
  });

  it('mounts the poll watcher when the client is optimistically paid but the receipt is not yet available', () => {
    optimisticValue = true;
    render(
      <ReceiptReveal
        invoiceId="inv-1"
        receiptAvailable={false}
        receiptAsyncPending={false}
        receiptAsyncFailed={false}
      />,
    );
    expect(screen.getByTestId('receipt-status-watcher-stub')).toBeTruthy();
    expect(watcherSpy).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv-1' }),
    );
  });

  it('renders nothing (no watcher) when the receipt download is already available', () => {
    optimisticValue = true;
    render(
      <ReceiptReveal
        invoiceId="inv-1"
        receiptAvailable={true}
        receiptAsyncPending={false}
        receiptAsyncFailed={false}
      />,
    );
    expect(screen.queryByTestId('receipt-status-watcher-stub')).toBeNull();
  });

  it('still mounts the watcher on the server-truth paid+pending path (no optimistic signal)', () => {
    optimisticValue = false;
    render(
      <ReceiptReveal
        invoiceId="inv-1"
        receiptAvailable={false}
        receiptAsyncPending={true}
        receiptAsyncFailed={false}
      />,
    );
    expect(screen.getByTestId('receipt-status-watcher-stub')).toBeTruthy();
  });
});
