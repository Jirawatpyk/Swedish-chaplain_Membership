/**
 * F5R3 CR-9 (2026-05-16) — regression coverage for PaymentFailurePanel
 * `role="status"` override (WCAG 4.1.3 + R2-CRIT-3 closure).
 *
 * R2-CRIT-3 was a UX12 half-fix: UX12 removed `role="alert"` +
 * `aria-live="assertive"` from the panel WRAPPER, but the
 * `<InlineAlert>` PRIMITIVE still defaults `role="alert"`. Without an
 * explicit override, screen readers double-announce on card failure
 * (assertive panel insertion + the parent <pay-sheet-internal>'s
 * polite announcer). Pre-R3 nothing pinned this — dropping the
 * `role="status"` prop in a future PR would silently regress.
 *
 * This test asserts:
 *   1. The rendered region uses role="status" (NOT role="alert").
 *   2. The destructive tone (visual affordance) is preserved.
 *   3. Title + body + retry CTA render with the supplied props.
 *   4. CTA target size meets WCAG 2.5.8 (≥44×44 px via min-h-[44px]).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { PaymentFailurePanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/payment-failure-panel';

const messages = {
  portal: {
    payment: {
      retry: {
        title: 'Payment did not go through',
        body: 'Reason: {reason}. Try again or use a different card.',
      },
    },
  },
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof PaymentFailurePanel>> = {}) {
  const onRetry = vi.fn();
  const props: React.ComponentProps<typeof PaymentFailurePanel> = {
    reason: 'card_declined',
    ctaLabel: 'Try another card',
    onRetry,
    testId: 'pay-sheet-failure-panel',
    ctaTestId: 'pay-sheet-failure-retry',
    ...overrides,
  };
  render(
    <NextIntlClientProvider messages={messages} locale="en">
      <PaymentFailurePanel {...props} />
    </NextIntlClientProvider>,
  );
  return { onRetry, props };
}

afterEach(() => cleanup());

describe('<PaymentFailurePanel> — R2-CRIT-3 / R3-CR-9 regression coverage', () => {
  it('renders with role="status" (NOT role="alert") — parent owns the polite announcer', () => {
    renderPanel();
    // Positive: the rendered region claims role=status (overrides the
    // InlineAlert default of role=alert).
    const region = screen.getByRole('status');
    expect(region).toBeDefined();
    expect(region.getAttribute('data-testid')).toBe('pay-sheet-failure-panel');
    // Negative: NO role=alert anywhere on the panel — a regression
    // that drops the `role="status"` prop would let InlineAlert's
    // default `role="alert"` survive and surface here.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves destructive visual tone (data-tone="destructive") for affordance', () => {
    renderPanel();
    const region = screen.getByRole('status');
    // The InlineAlert primitive applies the tone via class / data-attr.
    // Either surface is acceptable proof; we assert at least one.
    const hasDestructive =
      region.getAttribute('data-tone') === 'destructive' ||
      region.className.includes('destructive');
    expect(hasDestructive).toBe(true);
  });

  it('renders the localized title, body (with reason interpolation), and the supplied CTA label', () => {
    renderPanel({ reason: 'expired_card', ctaLabel: 'Retry' });
    expect(screen.getByText('Payment did not go through')).toBeDefined();
    expect(
      screen.getByText('Reason: expired_card. Try again or use a different card.'),
    ).toBeDefined();
    expect(screen.getByText('Retry')).toBeDefined();
  });

  it('CTA fires onRetry when clicked + carries min-h-[44px] for WCAG 2.5.8 target size', () => {
    const { onRetry } = renderPanel();
    const cta = screen.getByTestId('pay-sheet-failure-retry');
    expect(cta.className).toContain('min-h-[44px]');
    fireEvent.click(cta);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
