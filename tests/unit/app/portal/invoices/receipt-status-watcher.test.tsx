/**
 * 088 T066a (FR-019) — member-facing async receipt-PDF state.
 *
 * Unit test for `<ReceiptStatusWatcher>`: the client component mounted on the
 * portal invoice LIST rows + DETAIL page while `receiptPdfStatus === 'pending'`.
 * It (1) announces "your tax receipt is being generated" via an aria-live polite
 * region, and (2) POLLS the lightweight status endpoint on a backoff schedule,
 * calling `router.refresh()` to reveal the download automatically the moment the
 * async worker flips the row to 'rendered' (or the graceful-fail state on
 * 'failed') — WITHOUT a manual refresh. Any spinner respects reduced-motion via
 * `motion-safe:` utilities.
 *
 * Fake timers drive the poll loop; global fetch + next/navigation useRouter are
 * mocked so no network / Next runtime is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const dict: Record<string, string> = {
  'receiptStatus.generating': 'Your tax receipt is being generated',
  'receiptStatus.reassurance':
    'It is safe and will appear here automatically when it is ready.',
};
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => dict[key] ?? key,
}));

import {
  ReceiptStatusWatcher,
  RECEIPT_POLL_MAX_ATTEMPTS,
} from '@/app/(member)/portal/invoices/_components/receipt-status-watcher';

function jsonResponse(status: 'pending' | 'rendered' | 'failed' | null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status }),
  } as unknown as Response;
}

describe('<ReceiptStatusWatcher> (088 T066a — member async receipt state)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders an aria-live polite region announcing "being generated"', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('pending')));
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    const region = screen.getByTestId('receipt-status-watcher');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAttribute('role', 'status');
    expect(
      screen.getByText('Your tax receipt is being generated'),
    ).toBeInTheDocument();
  });

  it('spinner uses a motion-safe animation (reduced-motion respected)', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('pending')));
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    const region = screen.getByTestId('receipt-status-watcher');
    const svg = region.querySelector('svg');
    expect(svg?.getAttribute('class') ?? '').toContain('motion-safe:animate-spin');
  });

  it('the block variant shows the reassurance copy (why it takes a moment)', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('pending')));
    render(<ReceiptStatusWatcher invoiceId="inv-1" variant="block" />);
    expect(
      screen.getByText(
        'It is safe and will appear here automatically when it is ready.',
      ),
    ).toBeInTheDocument();
  });

  it('does NOT poll before the first backoff delay elapses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('pending'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    // No fetch synchronously on mount.
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); // > 5s base
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/portal/invoices/inv-1/receipt/status',
    );
  });

  it('reveals the download on render-ready: calls router.refresh() and STOPS polling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValueOnce(jsonResponse('rendered'))
      .mockResolvedValue(jsonResponse('rendered'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    // Drive several poll cycles.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    const callsAfterRendered = fetchMock.mock.calls.length;
    // Advance a lot more — polling must have STOPPED (no further fetches).
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterRendered);
  });

  it('on terminal FAILED it refreshes (to reveal the graceful-fail state) and stops', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValue(jsonResponse('failed'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('caps the poll loop at RECEIPT_POLL_MAX_ATTEMPTS then gives up (no refresh)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse('pending'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    // Advance well past the whole capped schedule (~3 min).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock.mock.calls.length).toBe(RECEIPT_POLL_MAX_ATTEMPTS);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('a network error does not throw or refresh — it keeps polling within the cap', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(jsonResponse('rendered'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReceiptStatusWatcher invoiceId="inv-1" />);
    await vi.advanceTimersByTimeAsync(60_000);
    // First poll threw (swallowed, still pending) → second poll saw rendered.
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
