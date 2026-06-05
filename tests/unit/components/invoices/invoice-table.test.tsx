/**
 * Component tests for the invoices admin table buyer column + Event chip
 * (054-event-fee-invoices Task 13).
 *
 * The "Member" column became the "Buyer" column: it now renders BOTH
 * membership invoices (linked to an F3 member) and event-fee invoices
 * (a non-member attendee with NO member row). The key invariants:
 *   - event non-member rows render the buyer name as PLAIN TEXT — never a
 *     broken `/admin/members/` link with an empty id;
 *   - membership rows keep the `/admin/members/{id}` link;
 *   - the Event chip appears ONLY on `invoiceSubject === 'event'` rows.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  InvoicesTable,
  type InvoicesTableRow,
} from '@/app/(staff)/admin/invoices/_components/invoice-table';

const messages = {
  admin: {
    invoices: {
      list: {
        columns: {
          documentNumber: 'Number',
          status: 'Status',
          issueDate: 'Issued',
          dueDate: 'Due',
          total: 'Total',
          actions: 'Actions',
          buyer: 'Buyer',
          method: 'Method',
          receiptNumber: 'Receipt No.',
        },
        statuses: {
          draft: 'Draft',
          issued: 'Issued',
          paid: 'Paid',
          void: 'Void',
          credited: 'Credited',
          partially_credited: 'Partially credited',
          overdue: 'Overdue',
        },
        subjectChip: {
          event: 'Event',
          eventAria: 'Event-fee invoice',
        },
        buyerSubtitle: {
          membership: 'Membership {year}',
        },
        creditedSuffix: '+{count} CN',
        creditedTooltip: '{count} credit notes · {amount} THB credited',
        creditedAria: '{count} credit notes, {amount} credited',
        receiptNumberCombinedTooltip: 'Combined mode',
        receiptNumberCombinedAria: 'Combined mode',
        actions: {
          download: 'Invoice',
          downloadReceipt: 'Receipt',
          downloadInvoiceAria: 'Download invoice {number}',
          downloadReceiptAria: 'Download receipt {number}',
          receiptPreparing: 'Receipt preparing…',
        },
      },
      detail: {
        toast: {
          downloadInProgress: 'Downloading…',
          invoiceForbidden: 'x',
          invoiceNotFound: 'x',
          invoiceUnavailable: 'x',
          invoiceSessionExpired: 'x',
          invoiceRateLimited: 'x',
          receiptPending: 'x',
          receiptFailed: 'x',
          receiptForbidden: 'x',
          receiptUnavailable: 'x',
          receiptSessionExpired: 'x',
          receiptRateLimited: 'x',
        },
      },
    },
    paymentReconciliation: {
      methodBadge: { card: 'Card', promptpay: 'PromptPay' },
    },
  },
};

function baseRow(overrides: Partial<InvoicesTableRow>): InvoicesTableRow {
  return {
    invoiceId: 'inv-1',
    documentNumber: 'INV-2026-0001',
    status: 'issued',
    invoiceSubject: 'membership',
    buyerHasMemberLink: true,
    memberId: 'member-uuid-1',
    memberName: 'Acme Co., Ltd.',
    issueDate: '2026-06-01',
    dueDate: '2026-06-15',
    totalSatang: '100000',
    hasPdf: true,
    creditNoteCount: 0,
    creditedTotalSatang: '0',
    onlinePaymentMethod: null,
    receiptDocumentNumberRaw: null,
    hasReceiptPdf: false,
    receiptPdfStatus: null,
    buyerSubtitle: null,
    ...overrides,
  };
}

function renderTable(rows: InvoicesTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InvoicesTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe('<InvoicesTable> buyer column', () => {
  it('renders the buyer header (renamed from "Member")', () => {
    renderTable([baseRow({})]);
    expect(
      screen.getByRole('columnheader', { name: 'Buyer' }),
    ).toBeInTheDocument();
  });

  it('renders a membership buyer as an /admin/members/ link', () => {
    renderTable([baseRow({ invoiceSubject: 'membership', buyerHasMemberLink: true })]);
    const link = screen.getByRole('link', { name: 'Acme Co., Ltd.' });
    expect(link).toHaveAttribute('href', '/admin/members/member-uuid-1');
  });

  it('renders an event non-member buyer as PLAIN TEXT — no /admin/members/ link', () => {
    renderTable([
      baseRow({
        invoiceId: 'inv-evt',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Walk-in Guest Co.',
      }),
    ]);
    // The buyer name is present as text…
    const buyerText = screen.getByText('Walk-in Guest Co.');
    expect(buyerText).toBeInTheDocument();
    // …but it is NOT a link (the broken-link fix). No link anywhere in the
    // document should target /admin/members/ with an empty id.
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('/admin/members/');
    }
    // Specifically, the buyer name itself is not wrapped in an anchor.
    expect(buyerText.closest('a')).toBeNull();
  });

  it('shows the Event chip ONLY on event rows', () => {
    renderTable([
      baseRow({ invoiceId: 'inv-m', invoiceSubject: 'membership', documentNumber: 'INV-M' }),
      baseRow({
        invoiceId: 'inv-e',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Guest',
        documentNumber: 'INV-E',
      }),
    ]);
    const chips = screen.getAllByText('Event');
    // Exactly one Event chip (the event row); the membership row has none.
    expect(chips).toHaveLength(1);
    const chip = chips[0]!;
    expect(chip).toHaveAttribute('aria-label', 'Event-fee invoice');
  });

  it('renders the membership-year subtitle under the buyer name', () => {
    renderTable([
      baseRow({
        invoiceSubject: 'membership',
        memberName: 'Acme Co., Ltd.',
        buyerSubtitle: 'Membership 2026',
      }),
    ]);
    // The buyer name and its muted subtitle are distinct text nodes.
    expect(screen.getByText('Acme Co., Ltd.')).toBeInTheDocument();
    expect(screen.getByText('Membership 2026')).toBeInTheDocument();
  });

  it('renders the event-name subtitle under an event buyer name', () => {
    renderTable([
      baseRow({
        invoiceId: 'inv-evt',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Walk-in Guest Co.',
        buyerSubtitle: 'TSCC Gala Dinner · 2026-06-15',
      }),
    ]);
    expect(screen.getByText('Walk-in Guest Co.')).toBeInTheDocument();
    expect(
      screen.getByText('TSCC Gala Dinner · 2026-06-15'),
    ).toBeInTheDocument();
  });

  it('omits the subtitle line when buyerSubtitle is null', () => {
    renderTable([baseRow({ memberName: 'No Subtitle Co.', buyerSubtitle: null })]);
    expect(screen.getByText('No Subtitle Co.')).toBeInTheDocument();
    // No "Membership …" text leaks when the row carries no subtitle.
    expect(screen.queryByText(/^Membership /)).not.toBeInTheDocument();
  });

  it('matched-member event invoice still links (buyerHasMemberLink=true)', () => {
    // An event invoice billed to a real F3 member keeps the link even
    // though the subject is "event" — the link decision is driven by
    // buyerHasMemberLink, not the subject.
    renderTable([
      baseRow({
        invoiceId: 'inv-em',
        invoiceSubject: 'event',
        buyerHasMemberLink: true,
        memberId: 'member-uuid-2',
        memberName: 'Member Attendee Co.',
      }),
    ]);
    const link = screen.getByRole('link', { name: 'Member Attendee Co.' });
    expect(link).toHaveAttribute('href', '/admin/members/member-uuid-2');
    // …and the Event chip is still present (it tracks subject).
    expect(screen.getByText('Event')).toBeInTheDocument();
  });
});
