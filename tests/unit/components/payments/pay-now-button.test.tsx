/**
 * Unit tests for <PayNowButton> — G4 T072.
 * Contract: specs/009-online-payment FR-025c + FR-030.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const searchParamsMock = {
  current: new URLSearchParams(),
};
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));

// Mock next/dynamic so the <PaySheet> loader resolves synchronously
// with a simple stub. We observe presence-only; the real drawer is
// covered by pay-sheet.test.tsx.
vi.mock('next/dynamic', async () => {
  const React = await import('react');
  // T082 2026-04-24: PayNowButton now auto-mounts PaySheet and
  // controls visibility via the `open` prop — it never unmounts on
  // close (preserves ephemeral payment state). The stub mirrors that
  // contract by branching on `open` instead of toggling mount state.
  function PaySheetStub(props: {
    onOpenChange?: (next: boolean) => void;
    open?: boolean;
    invoice: { invoiceNumber: string };
  }) {
    return React.createElement(
      'div',
      { 'data-testid': 'pay-sheet-stub-root' },
      props.open
        ? React.createElement(
            'div',
            { 'data-testid': 'pay-sheet-stub' },
            React.createElement(
              'button',
              {
                type: 'button',
                'data-testid': 'pay-sheet-stub-close',
                onClick: () => props.onOpenChange?.(false),
              },
              `close-${props.invoice.invoiceNumber}`,
            ),
          )
        : null,
    );
  }
  return {
    default: () => PaySheetStub,
  };
});

import { PayNowButton } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-now-button';

const messages = {
  portal: {
    payment: {
      payNow: 'Pay now',
    },
  },
};

const invoice = {
  id: 'inv_g4',
  invoiceNumber: 'TSCC-2026-0007',
  amountDue: 50_000,
  currency: 'THB',
  status: 'issued',
} as const;

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PayNowButton
        invoice={invoice}
        enabledMethods={['card', 'promptpay']}
        tenantPublishableKey="pk_test_fake"
      />
    </NextIntlClientProvider>,
  );
}

describe('<PayNowButton>', () => {
  beforeEach(() => {
    searchParamsMock.current = new URLSearchParams();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders a button labelled with portal.payment.payNow; drawer is present (auto-mounted) but closed', () => {
    // T082 2026-04-24: PayNowButton auto-mounts PaySheet on render so
    // the chunk + Stripe SDK is parsed before the user clicks. The
    // drawer body is only visible once `open` flips true.
    renderButton();
    const btn = screen.getByTestId('pay-now-button');
    expect(btn.textContent).toBe('Pay now');
    expect(screen.getByTestId('pay-sheet-stub-root')).toBeTruthy();
    // Body not visible until open.
    expect(screen.queryByTestId('pay-sheet-stub')).toBeNull();
  });

  it('opens the drawer on click', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('pay-now-button'));
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
  });

  it('auto-opens the drawer when ?pay=1 is in the URL (FR-025c)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderButton();
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
  });

  it('close signal hides the drawer body but keeps PaySheet mounted (preserves ephemeral state — T082)', () => {
    // Architectural invariant: onOpenChange(false) flips `open` but
    // does NOT unmount PaySheet. Keeping the tree mounted lets the
    // Stripe clientSecret + PaymentIntent survive close→reopen cycles
    // without refetching /api/payments/initiate (and burning through
    // the rate-limit budget). State lives in React memory only — PCI
    // SAQ-A still satisfied.
    renderButton();
    fireEvent.click(screen.getByTestId('pay-now-button'));
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pay-sheet-stub-close'));
    // Body hidden…
    expect(screen.queryByTestId('pay-sheet-stub')).toBeNull();
    // …but the PaySheet tree is still mounted.
    expect(screen.getByTestId('pay-sheet-stub-root')).toBeTruthy();
  });
});
