/**
 * Unit tests for <OrderSummary> — T082 UX polish commit 018b9cf.
 * Contract: specs/009-online-payment FR-028f OrderSummary block at
 * top of drawer — invoice number + amount due in formatted THB.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { OrderSummary } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/order-summary';

const messages = {
  portal: {
    payment: {
      summary: {
        heading: 'Order summary',
        invoiceLabel: 'Invoice',
        amountLabel: 'Amount due',
        billNote:
          'This is an invoice (ใบแจ้งหนี้), not a tax invoice. Your tax invoice/receipt is issued when you pay.',
        itemsLabel: 'Items',
        itemSingle: '1 item',
        itemPlural: '{count} items',
      },
    },
  },
};

function renderSummary(
  props: React.ComponentProps<typeof OrderSummary>,
  locale: 'en' | 'th' | 'sv' = 'en',
) {
  const localized: Record<'en' | 'th' | 'sv', typeof messages> = {
    en: messages,
    th: messages,
    sv: messages,
  };
  return render(
    <NextIntlClientProvider locale={locale} messages={localized[locale]}>
      <OrderSummary {...props} />
    </NextIntlClientProvider>,
  );
}

describe('<OrderSummary>', () => {
  afterEach(() => cleanup());

  it('renders the invoice number + amount from satang', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900003',
      amountDue: 535_000, // 5,350.00 THB
      currency: 'THB',
    });
    expect(screen.getByText('Order summary')).toBeTruthy();
    expect(screen.getByText('SC-2026-900003')).toBeTruthy();
    expect(
      screen.getByTestId('pay-sheet-summary-amount').textContent,
    ).toBe('5,350.00 THB');
  });

  it('formats amounts with sub-satang precision (edge: satang remainder)', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900099',
      amountDue: 100_050, // = 1,000.50 THB
      currency: 'THB',
    });
    expect(
      screen.getByTestId('pay-sheet-summary-amount').textContent,
    ).toBe('1,000.50 THB');
  });

  it('rounds half-satang inputs correctly (defensive: upstream may pass floats)', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900100',
      amountDue: 100.49, // fraction of 1 satang — rounds to 1 satang
      currency: 'THB',
    });
    // Round(100.49) → 100 satang → 1.00 THB.
    expect(
      screen.getByTestId('pay-sheet-summary-amount').textContent,
    ).toBe('1.00 THB');
  });

  it('handles a zero amount', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900101',
      amountDue: 0,
      currency: 'THB',
    });
    expect(
      screen.getByTestId('pay-sheet-summary-amount').textContent,
    ).toBe('0.00 THB');
  });

  it('exposes a labelled region for SR users', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900003',
      amountDue: 535_000,
      currency: 'THB',
    });
    const region = screen.getByTestId('pay-sheet-summary');
    expect(region.getAttribute('aria-labelledby')).toBe(
      'pay-sheet-summary-heading',
    );
    // Heading exists with the referenced id.
    const heading = screen.getByText('Order summary');
    expect(heading.id).toBe('pay-sheet-summary-heading');
  });

  it('formats the amount with the Swedish decimal comma on sv', () => {
    renderSummary(
      { invoiceNumber: 'SC-2026-900003', amountDue: 535_000, currency: 'THB' },
      'sv',
    );
    expect(
      screen.getByTestId('pay-sheet-summary-amount').textContent,
    ).toBe('5\u00a0350,00 THB');
  });

  it('notes that the tax invoice/receipt is issued at payment on an 088 bill', () => {
    renderSummary({
      invoiceNumber: 'SC-2026-900003',
      amountDue: 535_000,
      currency: 'THB',
      isBill: true,
    });
    expect(
      screen.getByTestId('pay-sheet-summary-bill-note').textContent,
    ).toContain('not a tax invoice');
  });

  it('omits the bill note on a legacy invoice', () => {
    renderSummary({
      invoiceNumber: 'INV-2025-000001',
      amountDue: 535_000,
      currency: 'THB',
    });
    expect(screen.queryByTestId('pay-sheet-summary-bill-note')).toBeNull();
  });
});
