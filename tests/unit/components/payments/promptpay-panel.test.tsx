/**
 * Unit tests for <PromptPayPanel> + `formatCountdown` — Phase 4 / T091.
 *
 * Coverage targets (review C4 fix, 2026-04-26):
 *   - `formatCountdown` 5 branches: clamp <0, non-integer floor,
 *     leading-zero padding (mm and ss), large value
 *   - <PromptPayPanel> 3 status states: pending, expired, waiting-confirmation
 *   - QR <img> onError → onLoadError callback fires (I4)
 *   - Refresh CTA wires onRefresh
 *   - Currency fallback path (currency !== 'thb')
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  PromptPayPanel,
  formatCountdown,
  type PromptPayPanelProps,
} from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/promptpay-panel';

const messages = {
  portal: {
    payment: {
      promptpay: {
        qrAlt: 'PromptPay QR code',
        instructions: 'Scan with any Thai bank app',
        amount: 'Amount: {amount}',
        warning: 'Only scan the QR code shown above; do NOT transfer manually.',
        countdown: 'Expires in {minutes}:{seconds}',
        refresh: 'Refresh QR',
        expired: 'QR code expired',
        expiredBody: 'Generate a new QR to continue.',
        waiting: 'Waiting for payment confirmation…',
        loadFailed: "Couldn't load PromptPay QR.",
      },
    },
  },
};

function renderWithIntl(props: PromptPayPanelProps) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PromptPayPanel {...props} />
    </NextIntlClientProvider>,
  );
}

const baseProps: PromptPayPanelProps = {
  qrSvgUrl: 'https://qr.stripe.com/v1/test.svg',
  amountSatang: 5_350_000,
  currency: 'thb',
  expirySeconds: 900,
  onRefresh: () => undefined,
};

// ---------------------------------------------------------------------------
// formatCountdown — pure helper
// ---------------------------------------------------------------------------

describe('formatCountdown', () => {
  it('clamps negative values to 00:00', () => {
    expect(formatCountdown(-5)).toEqual({ minutes: '00', seconds: '00' });
  });

  it('floors non-integer seconds to integer', () => {
    // 65.7 → floor → 65 → 01:05
    expect(formatCountdown(65.7)).toEqual({ minutes: '01', seconds: '05' });
  });

  it('zero-pads minutes and seconds (single-digit)', () => {
    expect(formatCountdown(7)).toEqual({ minutes: '00', seconds: '07' });
    expect(formatCountdown(60)).toEqual({ minutes: '01', seconds: '00' });
  });

  it('handles 15-minute window precisely', () => {
    expect(formatCountdown(900)).toEqual({ minutes: '15', seconds: '00' });
  });

  it('handles values larger than 99 minutes without truncation', () => {
    // 7200s = 120:00 — no MM cap by design
    expect(formatCountdown(7200)).toEqual({ minutes: '120', seconds: '00' });
  });
});

// ---------------------------------------------------------------------------
// <PromptPayPanel> — render branches
// ---------------------------------------------------------------------------

describe('<PromptPayPanel> — pending status', () => {
  it('renders QR image with non-empty alt + instructions + warning + Refresh CTA', () => {
    renderWithIntl({ ...baseProps, status: 'pending' });
    const qr = screen.getByTestId('pay-sheet-promptpay-qr');
    expect(qr).not.toBeNull();
    expect(qr.getAttribute('alt')).toBe('PromptPay QR code');
    expect(screen.getByText('Scan with any Thai bank app')).not.toBeNull();
    expect(screen.getByTestId('pay-sheet-promptpay-warning')).not.toBeNull();
    expect(screen.getByTestId('pay-sheet-promptpay-refresh')).not.toBeNull();
  });

  it('countdown region carries aria-live="polite" + initial 15:00 text', () => {
    renderWithIntl({ ...baseProps, status: 'pending', expirySeconds: 900 });
    const countdown = screen.getByTestId('pay-sheet-promptpay-countdown');
    expect(countdown.getAttribute('aria-live')).toBe('polite');
    expect(countdown.textContent).toContain('15:00');
  });

  it('Refresh CTA fires onRefresh', () => {
    const onRefresh = vi.fn();
    renderWithIntl({ ...baseProps, status: 'pending', onRefresh });
    fireEvent.click(screen.getByTestId('pay-sheet-promptpay-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders amount in THB locale when currency=thb', () => {
    renderWithIntl({ ...baseProps, status: 'pending', amountSatang: 5_350_000 });
    // formatSatangThb on 5_350_000 satang = THB 53,500.00 — exact format
    // is locale-dependent; assert presence of the THB digits.
    const amountNode = screen.getByText(/Amount:/);
    expect(amountNode.textContent).toMatch(/53,?500/);
  });

  it('falls back to raw amount + uppercase currency when currency!==thb', () => {
    renderWithIntl({
      ...baseProps,
      status: 'pending',
      currency: 'usd',
      amountSatang: 12345,
    });
    const amountNode = screen.getByText(/Amount:/);
    expect(amountNode.textContent).toContain('12345 USD');
  });

  it('fires onLoadError when QR <img> fails to load (I4 fix)', () => {
    const onLoadError = vi.fn();
    renderWithIntl({ ...baseProps, status: 'pending', onLoadError });
    const qr = screen.getByTestId('pay-sheet-promptpay-qr');
    fireEvent.error(qr);
    expect(onLoadError).toHaveBeenCalledTimes(1);
  });
});

describe('<PromptPayPanel> — expired status', () => {
  it('renders expired panel with role=alert + aria-live=assertive', () => {
    renderWithIntl({ ...baseProps, status: 'expired' });
    const expired = screen.getByTestId('pay-sheet-promptpay-expired');
    expect(expired).not.toBeNull();
    expect(expired.getAttribute('role')).toBe('alert');
    expect(expired.getAttribute('aria-live')).toBe('assertive');
    expect(screen.queryByTestId('pay-sheet-promptpay-qr')).toBeNull();
  });

  it('Refresh CTA fires onRefresh from expired panel', () => {
    const onRefresh = vi.fn();
    renderWithIntl({ ...baseProps, status: 'expired', onRefresh });
    fireEvent.click(screen.getByTestId('pay-sheet-promptpay-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('<PromptPayPanel> — waiting-confirmation status', () => {
  it('renders waiting indicator alongside QR', () => {
    renderWithIntl({ ...baseProps, status: 'waiting-confirmation' });
    expect(screen.getByTestId('pay-sheet-promptpay-qr')).not.toBeNull();
    expect(screen.getByTestId('pay-sheet-promptpay-waiting')).not.toBeNull();
    expect(screen.getByText('Waiting for payment confirmation…')).not.toBeNull();
  });
});

describe('<PromptPayPanel> — countdown effect lifecycle', () => {
  it('countdown ticks down with setInterval', () => {
    vi.useFakeTimers();
    try {
      renderWithIntl({ ...baseProps, status: 'pending', expirySeconds: 5 });
      const countdown = screen.getByTestId('pay-sheet-promptpay-countdown');
      expect(countdown.textContent).toContain('00:05');
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(countdown.textContent).toContain('00:03');
    } finally {
      vi.useRealTimers();
    }
  });

  it('automatically transitions to expired panel when countdown reaches 0', () => {
    vi.useFakeTimers();
    try {
      renderWithIntl({ ...baseProps, status: 'pending', expirySeconds: 2 });
      expect(screen.getByTestId('pay-sheet-promptpay-qr')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2_500);
      });
      expect(screen.getByTestId('pay-sheet-promptpay-expired')).not.toBeNull();
      expect(
        screen.queryByTestId('pay-sheet-promptpay-qr'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
