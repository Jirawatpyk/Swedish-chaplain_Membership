/**
 * Spec 122 US3 (`Main` board) — the home page leads with the unpaid
 * membership invoice: number, amount and due date, and Pay now straight into
 * the pay sheet when online payment is on; otherwise the invoice itself,
 * never a promise of online payment the tenant has not enabled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { MembershipInvoiceAlert } from '@/app/(member)/portal/_components/membership-invoice-alert';
import { selectMembershipInvoiceAlert } from '@/app/(member)/portal/_lib/membership-invoice-alert';
import type { OutstandingInvoiceInput } from '@/app/(member)/portal/_lib/dashboard-stats';

const inv = (over: Partial<OutstandingInvoiceInput>): OutstandingInvoiceInput => ({
  status: 'issued',
  totalSatang: 3_852_000n,
  dueDate: '2026-10-15',
  id: 'inv-1',
  invoiceSubject: 'membership',
  documentNumber: 'SC-2026-000123',
  ...over,
});

describe('selectMembershipInvoiceAlert', () => {
  it('picks the unpaid membership invoice due first, never an event invoice', () => {
    const picked = selectMembershipInvoiceAlert(
      [
        inv({ id: 'evt', invoiceSubject: 'event', dueDate: '2026-09-01' }),
        inv({ id: 'late', dueDate: '2026-12-01' }),
        inv({ id: 'soon', dueDate: '2026-10-15' }),
        inv({ id: 'paid', status: 'paid', dueDate: '2026-08-01' }),
      ],
      '2026-09-27',
    );
    expect(picked).toMatchObject({ id: 'soon', documentNumber: 'SC-2026-000123', totalSatang: 3_852_000n, overdue: false });
  });

  it('marks it overdue after its due date, and returns null when nothing is unpaid', () => {
    expect(selectMembershipInvoiceAlert([inv({ dueDate: '2026-09-01' })], '2026-09-27')?.overdue).toBe(true);
    expect(selectMembershipInvoiceAlert([inv({ status: 'paid' })], '2026-09-27')).toBeNull();
  });
});

function show(online: 'both' | 'card' | 'promptpay' | null, overdue = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MembershipInvoiceAlert
        invoiceId="inv-1"
        documentNumber="SC-2026-000123"
        amount="38,520.00 THB"
        dueDate="15 Oct 2026"
        overdue={overdue}
        online={online}
      />
    </NextIntlClientProvider>,
  );
}

describe('<MembershipInvoiceAlert>', () => {
  afterEach(cleanup);

  it('offers Pay now into the pay sheet when online payment is on', () => {
    show('both');
    expect(screen.getByText('Your membership invoice is ready')).toBeInTheDocument();
    expect(screen.getByText('SC-2026-000123 · 38,520.00 THB due 15 Oct 2026. Pay online by card or PromptPay.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pay now/ })).toHaveAttribute('href', '/portal/invoices/inv-1?pay=1');
  });

  it('names only the enabled method', () => {
    show('promptpay');
    expect(screen.getByText(/Pay online by PromptPay\.$/)).toBeInTheDocument();
  });

  it('links to the invoice without promising online payment when it is off', () => {
    show(null);
    expect(screen.getByText('SC-2026-000123 · 38,520.00 THB due 15 Oct 2026.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Pay now/ })).toBeNull();
    expect(screen.getByRole('link', { name: /View invoice/ })).toHaveAttribute('href', '/portal/invoices/inv-1');
  });

  it('says when it is overdue', () => {
    show('both', true);
    expect(screen.getByText(/was due 15 Oct 2026/)).toBeInTheDocument();
  });
});
