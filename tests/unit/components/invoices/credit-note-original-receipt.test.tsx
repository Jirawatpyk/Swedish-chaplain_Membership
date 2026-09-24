/**
 * The "Original receipt" cell on the credit-note list and detail pages.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  CreditNoteOriginalReceipt,
  CreditNoteRefundBadge,
} from '@/components/invoices/credit-note-original-receipt';

function renderCell(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('<CreditNoteOriginalReceipt>', () => {
  it('shows the RC and a "Bill SC-…" link to the invoice', () => {
    renderCell(
      <CreditNoteOriginalReceipt
        original={{
          receiptNumberRaw: 'RC-2026-000038',
          related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
        }}
        invoiceHref="/admin/invoices/inv-1"
      />,
    );
    expect(screen.getByText('RC-2026-000038')).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-1');
    expect(link.textContent).toMatch(/^Bill SC-2026-000102/);
  });

  it('every link names its receipt, so a list of "combined" links is not identical', () => {
    renderCell(
      <CreditNoteOriginalReceipt
        original={{ receiptNumberRaw: 'INV-2026-000052', related: { kind: 'combined' } }}
        invoiceHref="/admin/invoices/inv-2"
      />,
    );
    const link = screen.getByRole('link');
    // Visible text first (WCAG 2.5.3), then the receipt number for SR users.
    expect(link.textContent).toMatch(/^Combined tax invoice\/receipt/);
    expect(link.textContent).toContain('INV-2026-000052');
  });

  it('the touch size gives the link a 44px target (portal)', () => {
    renderCell(
      <CreditNoteOriginalReceipt
        original={{
          receiptNumberRaw: 'RC-2026-000038',
          related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
        }}
        invoiceHref="/portal/invoices/inv-1"
        size="touch"
      />,
    );
    expect(screen.getByRole('link').className).toContain('min-h-11');
  });

  it('shows "—" when there is no number', () => {
    renderCell(
      <CreditNoteOriginalReceipt
        original={{ receiptNumberRaw: null, related: null }}
        invoiceHref="/admin/invoices/inv-3"
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('<CreditNoteRefundBadge>', () => {
  it('uses the sans font even inside a mono table cell, and carries no hover-only hint', () => {
    renderCell(<CreditNoteRefundBadge />);
    const badge = screen.getByText('Refund');
    expect(badge.className).toContain('font-sans');
    expect(badge).not.toHaveAttribute('title');
  });
});
