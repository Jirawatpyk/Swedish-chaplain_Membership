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
  function PaySheetStub(props: {
    onClose?: () => void;
    invoice: { invoiceNumber: string };
  }) {
    return React.createElement(
      'div',
      { 'data-testid': 'pay-sheet-stub' },
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'pay-sheet-stub-close',
          onClick: () => props.onClose?.(),
        },
        `close-${props.invoice.invoiceNumber}`,
      ),
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

  it('renders a button labelled with portal.payment.payNow', () => {
    renderButton();
    const btn = screen.getByTestId('pay-now-button');
    expect(btn.textContent).toBe('Pay now');
    expect(screen.queryByTestId('pay-sheet-stub')).toBeNull();
  });

  it('mounts the drawer on click', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('pay-now-button'));
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
  });

  it('auto-mounts the drawer when ?pay=1 is in the URL (FR-025c)', () => {
    searchParamsMock.current = new URLSearchParams('pay=1');
    renderButton();
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
  });

  it('onClose callback unmounts the drawer', () => {
    renderButton();
    fireEvent.click(screen.getByTestId('pay-now-button'));
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pay-sheet-stub-close'));
    expect(screen.queryByTestId('pay-sheet-stub')).toBeNull();
  });
});
