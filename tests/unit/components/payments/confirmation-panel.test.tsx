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

const messages = {
  portal: {
    payment: {
      success: {
        title: 'Payment received',
        summaryCard: 'Paid {amount} via card ending {last4} on {dateTime}',
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

// Test-overrides type: allow `last4: undefined` explicitly so tests
// can simulate "no last4 supplied". `exactOptionalPropertyTypes: true`
// rejects this on `Partial<ConfirmationPanelProps>` (an optional field
// must be omitted, not set to undefined), so we widen the override
// type with `| undefined` for the optional fields here only.
type ConfirmationPanelOverrides = Omit<
  Partial<React.ComponentProps<typeof ConfirmationPanel>>,
  'last4'
> & {
  last4?: string | undefined;
};

function renderPanel(overrides: ConfirmationPanelOverrides = {}) {
  // Build defaults, then merge overrides while DELETING any keys that
  // were explicitly set to `undefined` so the resulting props object
  // satisfies `exactOptionalPropertyTypes: true` at the JSX boundary.
  const merged: Record<string, unknown> = {
    method: 'card',
    amount: 'THB 12,000.00',
    last4: '4242',
    dateTime: '2026-04-23 14:30',
    receiptUrl: 'https://example.com/receipt.pdf',
    onClose: vi.fn(),
    onDownload: vi.fn(),
    ...overrides,
  };
  for (const key of Object.keys(overrides) as Array<keyof typeof overrides>) {
    if (overrides[key] === undefined) {
      delete merged[key as string];
    }
  }
  // Omit last4 if promptpay (exactOptionalPropertyTypes).
  if (merged['method'] === 'promptpay') {
    delete merged['last4'];
  }
  const props = merged as unknown as React.ComponentProps<typeof ConfirmationPanel>;
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
    renderPanel({ method: 'card', last4: '4242' });
    expect(screen.getByTestId('pay-sheet-confirmation-icon')).toBeTruthy();
    expect(screen.getByText('Payment received')).toBeTruthy();
    expect(
      screen.getByText(
        'Paid THB 12,000.00 via card ending ****4242 on 2026-04-23 14:30',
      ),
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

  it('dual-node aria-live: visible tick is aria-hidden; SR announces at remaining ∈ [3, 1] (R3 — multi-threshold matches HardCapPrompt 30/10/5/1)', async () => {
    renderPanel();
    const visible = screen.getByTestId('pay-sheet-confirmation-countdown');
    const sr = screen.getByTestId('pay-sheet-confirmation-countdown-sr');
    // Visible tick is aria-hidden so SR doesn't flood every second.
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(sr.getAttribute('aria-live')).toBe('polite');
    expect(sr.getAttribute('aria-atomic')).toBe('true');
    // R3 cadence: silent pre-3s; fires at remaining=3; silent at 2;
    // fires again at 1 (final warning before dismissal). Two threshold
    // announcements total — still well below HardCapPrompt's 4 — but
    // guarantees SR users hear at least one cue + a "1 second" warning.
    expect(sr.textContent).toBe('');
    // Tick 2s → remaining=3 → SR fires (first threshold).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(sr.textContent).toContain('3');
    // Tick to remaining=2 → SR silent (between thresholds).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toBe('');
    // Tick to remaining=1 → SR fires final warning (R3 cadence change).
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

  // -- last4 mask polish (commit 675abe7) -----------------------------------
  describe('last4 mask (commit 675abe7)', () => {
    it('renders `****1234` when a real 4-digit last4 is supplied', () => {
      renderPanel({ method: 'card', last4: '1234' });
      expect(
        screen.getByText(
          'Paid THB 12,000.00 via card ending ****1234 on 2026-04-23 14:30',
        ),
      ).toBeTruthy();
    });

    it('renders a plain `****` when last4 is missing (no 8-asterisk bug)', () => {
      renderPanel({ method: 'card', last4: undefined });
      // MUST NOT render "********" (8 stars) — that was the pre-675abe7
      // bug where the i18n template + prop default double-masked.
      const text = screen.getByText(/via card ending/).textContent ?? '';
      expect(text).toMatch(/via card ending \*\*\*\* on/);
      expect(text).not.toMatch(/\*{5,}/);
    });

    it('falls back to `****` when last4 is not exactly 4 digits (defensive)', () => {
      renderPanel({ method: 'card', last4: '12' });
      const text = screen.getByText(/via card ending/).textContent ?? '';
      expect(text).toMatch(/via card ending \*\*\*\* on/);
    });

    it('falls back to `****` when last4 is non-digit (defensive)', () => {
      renderPanel({ method: 'card', last4: 'abcd' });
      const text = screen.getByText(/via card ending/).textContent ?? '';
      expect(text).toMatch(/via card ending \*\*\*\* on/);
    });
  });

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
