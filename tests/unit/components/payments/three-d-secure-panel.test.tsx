/**
 * Unit tests for <ThreeDSecurePanel> — G3 T078.
 * Contract: specs/009-online-payment FR-028d.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { ThreeDSecurePanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/three-d-secure-panel';

const messages = {
  portal: {
    payment: {
      threeDSecure: {
        title: 'Verifying with your bank…',
        body: 'Follow the prompts from your bank in the window above.',
        cancel: 'Cancel payment',
      },
    },
  },
};

function renderWithIntl(onCancel: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThreeDSecurePanel onCancel={onCancel} />
    </NextIntlClientProvider>,
  );
}

describe('<ThreeDSecurePanel>', () => {
  it('aria-live region with localized title', () => {
    renderWithIntl(() => {});
    const panel = screen.getByTestId('pay-sheet-3ds-panel');
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(panel.getAttribute('role')).toBe('status');
    expect(screen.getByText('Verifying with your bank…')).toBeTruthy();
  });

  it('renders a tertiary (ghost) cancel button and invokes onCancel', () => {
    const onCancel = vi.fn();
    renderWithIntl(onCancel);
    const cancel = screen.getByTestId('pay-sheet-3ds-cancel');
    // Button primitive carries the variant class; the `ghost` variant
    // has distinct hover:bg-muted class.
    expect(cancel.className).toMatch(/hover:bg-muted/);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Cancel button has ≥44px tap target (G-Review #7 / WCAG 2.5.5)', () => {
    renderWithIntl(() => {});
    const btn = screen.getByTestId('pay-sheet-3ds-cancel');
    expect(btn.className).toMatch(/min-h-\[44px\]/);
  });

  it('renders indeterminate <Progress> (role=progressbar, no aria-valuenow)', () => {
    renderWithIntl(() => {});
    const panel = screen.getByTestId('pay-sheet-3ds-panel');
    const bar = panel.querySelector('[data-slot="progress"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('data-state')).toBe('indeterminate');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    // Indeterminate fill still carries motion-safe skeleton-shimmer class
    const fill = bar.querySelector('[data-slot="progress-fill"]') as HTMLElement;
    expect(fill.className).toMatch(/skeleton-shimmer/);
  });
});
