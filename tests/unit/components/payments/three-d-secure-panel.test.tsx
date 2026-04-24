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

  it('uses the shared <Skeleton> primitive (motion-safe shimmer via .skeleton-shimmer)', () => {
    renderWithIntl(() => {});
    const panel = screen.getByTestId('pay-sheet-3ds-panel');
    const skeletons = panel.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
    skeletons.forEach((el) => {
      expect(el.className).toMatch(/skeleton-shimmer/);
    });
  });
});
