/**
 * Unit tests for <StatusPanel> — shared between processing + 3DS states.
 * Replaces the per-kind processing-panel.test + three-d-secure-panel.test
 * after S2 collapse + S1 wrapper deletion.
 *
 * Contract: specs/009-online-payment FR-028d.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { StatusPanel } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/status-panel';

const messages = {
  portal: {
    payment: {
      processing: {
        title: 'Processing payment…',
        body: 'Don’t close this window — we’re confirming your payment with the bank.',
        cancel: 'Cancel payment',
      },
      threeDSecure: {
        title: 'Verifying with your bank…',
        body: 'Complete the 3D Secure challenge in the popup or your bank app.',
        cancel: 'Cancel payment',
      },
    },
  },
};

function renderWithIntl(
  kind: 'processing' | 'three-d-secure',
  onCancel: () => void,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusPanel kind={kind} onCancel={onCancel} />
    </NextIntlClientProvider>,
  );
}

describe('<StatusPanel kind="processing">', () => {
  it('renders an aria-live region with role="status"', () => {
    renderWithIntl('processing', () => {});
    const panel = screen.getByTestId('pay-sheet-processing-panel');
    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.getAttribute('aria-live')).toBe('polite');
  });

  it('displays the localized title and body', () => {
    renderWithIntl('processing', () => {});
    expect(screen.getByText('Processing payment…')).toBeTruthy();
    expect(
      screen.getByText(
        'Don’t close this window — we’re confirming your payment with the bank.',
      ),
    ).toBeTruthy();
  });

  it('Cancel button invokes onCancel', () => {
    const onCancel = vi.fn();
    renderWithIntl('processing', onCancel);
    fireEvent.click(screen.getByTestId('pay-sheet-processing-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('Cancel button has ≥44px tap target (WCAG 2.5.5)', () => {
    renderWithIntl('processing', () => {});
    const btn = screen.getByTestId('pay-sheet-processing-cancel');
    expect(btn).toHaveClass('aura-btn--touch');
  });
});

describe('<StatusPanel kind="three-d-secure">', () => {
  it('shows a lock while the bank challenge is open; processing shows the spinner (`Pay-3ds` board)', () => {
    const { container, unmount } = renderWithIntl('three-d-secure', () => {});
    expect(container.querySelector('.motion-safe\\:animate-spin')).toBeNull();
    unmount();
    const processing = renderWithIntl('processing', () => {});
    expect(processing.container.querySelector('.motion-safe\\:animate-spin')).not.toBeNull();
  });

  it('renders an aria-live region with role="status" + 3DS testid', () => {
    renderWithIntl('three-d-secure', () => {});
    const panel = screen.getByTestId('pay-sheet-3ds-panel');
    expect(panel.getAttribute('role')).toBe('status');
    expect(panel.getAttribute('aria-live')).toBe('polite');
  });

  it('displays the localized 3DS title + body', () => {
    renderWithIntl('three-d-secure', () => {});
    expect(screen.getByText('Verifying with your bank…')).toBeTruthy();
    expect(
      screen.getByText(
        'Complete the 3D Secure challenge in the popup or your bank app.',
      ),
    ).toBeTruthy();
  });

  it('3DS Cancel button invokes onCancel', () => {
    const onCancel = vi.fn();
    renderWithIntl('three-d-secure', onCancel);
    fireEvent.click(screen.getByTestId('pay-sheet-3ds-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('3DS Cancel button has ≥44px tap target (WCAG 2.5.5)', () => {
    renderWithIntl('three-d-secure', () => {});
    const btn = screen.getByTestId('pay-sheet-3ds-cancel');
    expect(btn).toHaveClass('aura-btn--touch');
  });
});
