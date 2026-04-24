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

import { ConfirmationPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/confirmation-panel';

const messages = {
  portal: {
    payment: {
      success: {
        title: 'Payment received',
        summaryCard: 'Paid {amount} via card ending ****{last4} on {dateTime}',
        summaryPromptPay: 'Paid {amount} via PromptPay on {dateTime}',
        downloadReceipt: 'Download receipt',
        close: 'Close',
        autoCloseCountdown: 'Closing in {seconds} s',
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
    last4: '4242',
    dateTime: '2026-04-23 14:30',
    receiptUrl: 'https://example.com/receipt.pdf',
    onClose: vi.fn(),
    onDownload: vi.fn(),
    ...overrides,
  };
  // Omit last4 if promptpay (exactOptionalPropertyTypes).
  if (props.method === 'promptpay') {
    const { last4: _last4, ...rest } = props;
    void _last4;
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ConfirmationPanel {...rest} />
      </NextIntlClientProvider>,
    );
    return rest as typeof props;
  }
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

  it('dual-node aria-live: visible tick is aria-hidden; SR announces only at 3/2/1s (G-Review #6)', async () => {
    renderPanel();
    const visible = screen.getByTestId('pay-sheet-confirmation-countdown');
    const sr = screen.getByTestId('pay-sheet-confirmation-countdown-sr');
    // Visible tick is aria-hidden so SR doesn't flood every second.
    expect(visible.getAttribute('aria-hidden')).toBe('true');
    expect(sr.getAttribute('aria-live')).toBe('polite');
    expect(sr.getAttribute('aria-atomic')).toBe('true');
    // At t=0 (remaining=5) the SR node is empty.
    expect(sr.textContent).toBe('');
    // Tick 2s → remaining=3 → SR starts announcing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(sr.textContent).toContain('3');
    // Tick to remaining=2.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toContain('2');
    // Tick to remaining=1.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(sr.textContent).toContain('1');
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
});
