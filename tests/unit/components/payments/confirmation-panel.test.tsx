/**
 * Unit tests for <ConfirmationPanel> — G3 T079.
 * Contract: specs/009-online-payment FR-028e.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));
import { toast } from 'sonner';

import {
  AUTO_CLOSE_SECONDS,
  ConfirmationPanel,
} from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/confirmation-panel';

// review-20260428-102639.md W15 closure — `last4` removed from
// ConfirmationPanelProps and from i18n template. Mock copies the
// real production strings (see src/i18n/messages/en.json) so tests
// don't drift again on future copy edits.
const messages = {
  portal: {
    payment: {
      success: {
        title: 'Payment received',
        summaryCard: 'Paid {amount} by card on {dateTime}',
        summaryPromptPay: 'Paid {amount} via PromptPay on {dateTime}',
        downloadReceipt: 'Download receipt',
        close: 'Close',
        autoCloseCountdown: 'Closing in {seconds} s',
        pauseAutoClose: 'Pause',
        resumeAutoClose: 'Resume',
        autoClosePaused: 'Auto-close paused',
        toast: 'Payment received. Receipt emailed to you.',
      },
    },
  },
};

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ConfirmationPanel>> = {},
) {
  const props: React.ComponentProps<typeof ConfirmationPanel> = {
    method: 'card',
    amount: 'THB 12,000.00',
    dateTime: '2026-04-23 14:30',
    receiptUrl: 'https://example.com/receipt.pdf',
    onClose: vi.fn(),
    onDownload: vi.fn(),
    ...overrides,
  };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConfirmationPanel {...props} />
    </NextIntlClientProvider>,
  );
  return props;
}

describe('<ConfirmationPanel>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(toast.success).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders checkmark icon + title + card summary variant', () => {
    renderPanel({ method: 'card' });
    expect(screen.getByTestId('pay-sheet-confirmation-icon')).toBeTruthy();
    expect(screen.getByText('Payment received')).toBeTruthy();
    expect(
      screen.getByText('Paid THB 12,000.00 by card on 2026-04-23 14:30'),
    ).toBeTruthy();
  });

  it('renders PromptPay summary variant (no last4)', () => {
    renderPanel({ method: 'promptpay' });
    expect(
      screen.getByText(
        'Paid THB 12,000.00 via PromptPay on 2026-04-23 14:30',
      ),
    ).toBeTruthy();
  });

  it('fires sonner.success toast on mount', () => {
    renderPanel();
    expect(toast.success).toHaveBeenCalledWith(
      'Payment received. Receipt emailed to you.',
    );
  });

  it('auto-close countdown ticks from 5 → 0 and invokes onClose', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    expect(screen.getByTestId('pay-sheet-confirmation-countdown').textContent)
      .toContain('5');
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    // Drain both microtasks and the React 19 startTransition flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('dual-node aria-live: visible tick is aria-hidden; SR announces at remaining ∈ [5, 3, 1] (S10 — multi-threshold matches HardCapPrompt 30/10/5/1)', async () => {
    renderPanel();
    const visible = screen.getByTestId('pay-sheet-confirmation-countdown');
    const sr = screen.getByTestId('pay-sheet-confirmation-countdown-sr');
    // Visible tick is aria-hidden so SR doesn't flood every second.
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(sr.getAttribute('aria-live')).toBe('polite');
    expect(sr.getAttribute('aria-atomic')).toBe('true');
    // S10 cadence (review-20260428-102639.md S10 closure): fires at
    // remaining ∈ [5, 3, 1]. AUTO_CLOSE_SECONDS=5 so the opening cue
    // fires synchronously on first render (initial remaining=5).
    expect(sr.textContent).toContain('5');
    // Tick to remaining=4 → SR silent (between thresholds).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toBe('');
    // Tick to remaining=3 → SR fires (mid-window check).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toContain('3');
    // Tick to remaining=2 → SR silent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toBe('');
    // Tick to remaining=1 → SR fires final warning.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toContain('1');
    // R4 boundary: at remaining=0 the SR live region must go silent
    // again (the dispatch effect calls onExpire, but the live-region
    // node should NOT continue announcing "0 s" — that's a stale tick).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });
    expect(sr.textContent).toBe('');
  });

  it('download receipt anchor has ≥44px tap target (G-Review #5)', () => {
    renderPanel();
    const link = screen.getByTestId('pay-sheet-download-receipt');
    expect(link.className).toMatch(/min-h-\[44px\]/);
  });

  it('clicking "Download receipt" invokes onDownload and does NOT auto-close', async () => {
    const onClose = vi.fn();
    const onDownload = vi.fn();
    renderPanel({ onClose, onDownload });
    const link = screen.getByTestId('pay-sheet-download-receipt');
    fireEvent.click(link);
    expect(onDownload).toHaveBeenCalledOnce();
    // Advance past the would-be auto-close deadline.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Pause button (R3 WCAG 2.2.1) freezes countdown + onClose never fires; SR + visible nodes show "Auto-close paused"', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    const pauseBtn = screen.getByTestId('pay-sheet-confirmation-pause');
    fireEvent.click(pauseBtn);

    // After pause: visible countdown swaps to the paused-state copy.
    const visible = screen.getByTestId('pay-sheet-confirmation-countdown');
    expect(visible.textContent).toBe('Auto-close paused');

    // SR live region also reflects the pause (single update — aria-atomic).
    const sr = screen.getByTestId('pay-sheet-confirmation-countdown-sr');
    expect(sr.textContent).toBe('Auto-close paused');

    // The Pause button itself disappears once paused (no double-pause).
    expect(screen.queryByTestId('pay-sheet-confirmation-pause')).toBeNull();

    // Advance past 2× the would-be auto-close deadline. R4: anchored to
    // `AUTO_CLOSE_SECONDS` so a future UX retune (e.g. 8s) doesn't
    // silently invalidate this assertion.
    for (let i = 0; i < AUTO_CLOSE_SECONDS * 2; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking "Close" invokes onClose immediately', () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByTestId('pay-sheet-confirmation-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('download link has target=_blank + rel=noopener noreferrer', () => {
    renderPanel();
    const link = screen.getByTestId('pay-sheet-download-receipt');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://example.com/receipt.pdf');
  });

  // -- last4 mask polish (commit 675abe7) — REMOVED 2026-04-28 -------------
  //
  // The `last4` prop and `{last4}` i18n placeholder were both removed by
  // review-20260428-102639.md W15 closure. Stripe `confirmPayment` does
  // not return the card object on the happy path, and the extra
  // `expand=payment_method` round-trip costs latency for what is
  // informational copy only. The 4 tests previously here (****1234 /
  // missing / non-4-digit / non-digit) are obsolete — there is no
  // last4 string to mask anymore.

  // -- Option A layout (commit 675abe7) -------------------------------------
  describe('button layout (Option A — full-width primary + text-link close)', () => {
    it('Download receipt takes full drawer width (primary CTA)', () => {
      renderPanel();
      const link = screen.getByTestId('pay-sheet-download-receipt');
      expect(link.className).toMatch(/w-full/);
    });

    it('Close is a subdued text-link (muted-foreground + hover underline)', () => {
      renderPanel();
      const close = screen.getByTestId('pay-sheet-confirmation-close');
      // Not a shadcn Button with `bg-*` — it's a <button> styled as
      // a link. Verify the muted-foreground + hover underline utilities
      // (visual hierarchy: Close recedes behind the primary Download).
      expect(close.tagName.toLowerCase()).toBe('button');
      expect(close.className).toMatch(/text-muted-foreground/);
      expect(close.className).toMatch(/hover:underline/);
    });

    it('Close keeps ≥44px tap target for mobile (WCAG SC 2.5.5)', () => {
      renderPanel();
      const close = screen.getByTestId('pay-sheet-confirmation-close');
      expect(close.className).toMatch(/min-h-\[44px\]/);
    });
  });

  // -- Auto-close dispatch out of setState updater (commit 952740d) ---------
  it('React 19 setState-during-render guard: no error when countdown hits 0', async () => {
    // The earlier auto-close pattern called `onClose()` from INSIDE
    // `setRemaining((prev) => { ... })`. React flagged "Cannot update a
    // component while rendering a different component". The fix split
    // the ticker + dispatch into two effects. This test verifies the
    // dispatch path runs cleanly without any console.error.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onClose = vi.fn();
    renderPanel({ onClose });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledOnce();
    // No "setState during render" warning.
    const noise = errorSpy.mock.calls.some((call) =>
      String(call[0] ?? '').includes('setState'),
    );
    expect(noise).toBe(false);
    errorSpy.mockRestore();
  });
});
