/**
 * Unit tests for <HardCapPrompt> — B3 / FR-028c 30-min hard-cap.
 * Contract: specs/009-online-payment FR-028c.
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

import { HardCapPrompt } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/hard-cap-prompt';

const messages = {
  portal: {
    payment: {
      hardCap: {
        title: 'Are you still here?',
        body: 'The payment drawer has been open for 30 minutes. Click Continue to keep your payment session active, otherwise this attempt will be canceled automatically.',
        continue: 'Continue payment',
        autoCancelCountdown: 'Cancelling in {seconds} s',
      },
    },
  },
};

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('<HardCapPrompt> (B3 / FR-028c)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders title + body + continue CTA + countdown', () => {
    renderWithIntl(<HardCapPrompt onContinue={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Are you still here?')).toBeTruthy();
    expect(
      screen.getByText(/payment drawer has been open for 30 minutes/i),
    ).toBeTruthy();
    expect(
      screen.getByTestId('pay-sheet-hard-cap-continue').textContent,
    ).toBe('Continue payment');
    expect(
      screen.getByTestId('pay-sheet-hard-cap-countdown').textContent,
    ).toBe('Cancelling in 60 s');
  });

  it('decrements the visible countdown every second', () => {
    renderWithIntl(<HardCapPrompt onContinue={vi.fn()} onCancel={vi.fn()} />);
    const countdown = screen.getByTestId('pay-sheet-hard-cap-countdown');
    expect(countdown.textContent).toBe('Cancelling in 60 s');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdown.textContent).toBe('Cancelling in 59 s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(countdown.textContent).toBe('Cancelling in 54 s');
  });

  it('calls onContinue and stops the countdown when the CTA is clicked', () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    renderWithIntl(
      <HardCapPrompt onContinue={onContinue} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId('pay-sheet-hard-cap-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    // Countdown should NOT reach zero even if we advance past 60 s —
    // the interruptedRef halts the tick effect.
    act(() => {
      vi.advanceTimersByTime(70_000);
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel exactly once when countdown hits zero', () => {
    const onContinue = vi.fn();
    const onCancel = vi.fn();
    renderWithIntl(
      <HardCapPrompt onContinue={onContinue} onCancel={onCancel} />,
    );
    // Advance one second shy of the full countdown — still pending.
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(onCancel).not.toHaveBeenCalled();
    // Final tick pushes remaining to 0 + triggers the separate
    // "watch remaining" effect.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Further timer advances must NOT re-fire onCancel (the watch
    // effect is guarded by `remaining !== 0`).
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('exposes role="alertdialog" with assertive aria-live for SR users', () => {
    renderWithIntl(<HardCapPrompt onContinue={vi.fn()} onCancel={vi.fn()} />);
    const prompt = screen.getByTestId('pay-sheet-hard-cap-prompt');
    expect(prompt.getAttribute('role')).toBe('alertdialog');
    expect(prompt.getAttribute('aria-live')).toBe('assertive');
    expect(prompt.getAttribute('aria-atomic')).toBe('true');
  });
});
