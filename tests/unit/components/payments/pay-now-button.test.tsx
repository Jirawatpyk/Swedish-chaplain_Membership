/**
 * Unit tests for <PayNowButton> — G4 T072.
 * Contract: specs/009-online-payment FR-025c + FR-030.
 *
 * Refactored 2026-04-25 (code-quality audit closeout):
 * PaySheet is now a static import (lazy boundary moved INWARD into
 * <PaySheetInternal>). We mock the sibling `./index` module to swap
 * <PaySheet> for a presence-stub; the real drawer is covered by
 * pay-sheet.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

const searchParamsMock = {
  current: new URLSearchParams(),
};
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParamsMock.current,
}));

// Stub the sibling PaySheet so PayNowButton is unit-tested in isolation.
// Mirrors the controlled-component contract: PaySheet is ALWAYS mounted
// (eager Sheet shell after audit refactor), body visibility branches
// on the `open` prop.
vi.mock(
  '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/index',
  () => ({
    PaySheet: (props: {
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
      invoice: { invoiceNumber: string };
    }) =>
      React.createElement(
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
      ),
  }),
);

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

  it('renders a button labelled with portal.payment.payNow; drawer present (eager mount) but closed', () => {
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
    // PaySheet is eagerly mounted by the refactor — onOpenChange(false)
    // flips `open` but PaySheet itself never unmounts. The Stripe
    // clientSecret + PaymentIntent state lives inside <PaySheetInternal>
    // (lazy chunk inside PaySheet) and survives close→reopen cycles.
    renderButton();
    fireEvent.click(screen.getByTestId('pay-now-button'));
    expect(screen.getByTestId('pay-sheet-stub')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pay-sheet-stub-close'));
    expect(screen.queryByTestId('pay-sheet-stub')).toBeNull();
    expect(screen.getByTestId('pay-sheet-stub-root')).toBeTruthy();
  });
});
