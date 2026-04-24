/**
 * Unit tests for <ProcessingPanel> — G3 T077.
 * Contract: specs/009-online-payment FR-028d.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { ProcessingPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/processing-panel';

const messages = {
  portal: {
    payment: {
      processing: {
        title: 'Processing payment…',
        body: 'Don’t close this window — we’re confirming your payment with the bank.',
        cancel: 'Cancel payment',
      },
    },
  },
};

function renderWithIntl(onCancel: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProcessingPanel onCancel={onCancel} />
    </NextIntlClientProvider>,
  );
}

describe('<ProcessingPanel>', () => {
  it('renders an aria-live region with role="status"', () => {
    renderWithIntl(() => {});
    const panel = screen.getByTestId('pay-sheet-processing-panel');
    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.getAttribute('aria-live')).toBe('polite');
  });

  it('displays the localized title and body', () => {
    renderWithIntl(() => {});
    expect(screen.getByText('Processing payment…')).toBeTruthy();
    expect(
      screen.getByText(
        'Don’t close this window — we’re confirming your payment with the bank.',
      ),
    ).toBeTruthy();
  });

  it('Cancel button invokes onCancel', () => {
    const onCancel = vi.fn();
    renderWithIntl(onCancel);
    fireEvent.click(screen.getByTestId('pay-sheet-processing-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Cancel button has ≥44px tap target (G-Review #7 / WCAG 2.5.5)', () => {
    renderWithIntl(() => {});
    const btn = screen.getByTestId('pay-sheet-processing-cancel');
    expect(btn.className).toMatch(/min-h-\[44px\]/);
  });
});
