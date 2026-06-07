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
        tableCaption: 'List of invoices for the selected filters.',
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

/**
 * Receipt-No. column combined-hint gate (Round-2 /code-review C2).
 *
 * The receipt-number cell has three branches:
 *   1. `receiptDocumentNumberRaw` set       → render the raw §87 RC number
 *      (separate-mode).
 *   2. else `hasReceiptPdf && status==='paid'` → render the combined-mode
 *      hint (plain em-dash + InfoIcon, `aria-label=receiptNumberCombinedAria`)
 *      — the receipt reuses the invoice number per Thai RD §86/4 + §105ทวิ,
 *      and the receipt PDF has actually rendered (`hasReceiptPdf` is
 *      `paid && receiptPdf !== null`, page.tsx:396).
 *   3. else                                 → render a PLAIN em-dash.
 *
 * The gate at invoice-table.tsx:361 was hardened from a bare
 * `r.status === 'paid'` to `r.hasReceiptPdf && r.status === 'paid'` so a
 * paid combined-mode invoice whose receipt PDF is STILL RENDERING
 * (`hasReceiptPdf: false`, `receiptPdfStatus: 'pending'`) no longer shows
 * the "receipt = invoice number" hint prematurely. These cases pin that
 * gate; case 1 flips RED if anyone reverts to the bare status check.
 */
describe('<InvoicesTable> receipt-number combined-hint gate', () => {
  // The accessible name of the combined-mode hint span — the discriminator
  // between the combined branch (has the aria-label) and the plain-em-dash
  // branch (no aria-label). Mirrors `messages…receiptNumberCombinedAria`.
  const COMBINED_HINT_LABEL = 'Combined mode';

  it('paid + receipt mid-render (hasReceiptPdf=false) shows a PLAIN em-dash, not the combined hint', () => {
    // The mutation-sensitive case. With the hardened gate
    // (`hasReceiptPdf && status==='paid'`) this row falls into the plain
    // em-dash branch because the receipt PDF has not rendered yet. If the
    // gate is reverted to bare `r.status === 'paid'`, this paid + null-raw
    // row wrongly enters the combined branch and the hint appears — making
    // the `toBeNull()` assertion below FAIL. That is the regression guard.
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'pending',
      }),
    ]);
    // No combined-mode hint: neither the aria-labelled span…
    expect(screen.queryByLabelText(COMBINED_HINT_LABEL)).toBeNull();
    // …nor its InfoIcon decoration is in the document.
    expect(document.querySelector('svg.lucide-info')).toBeNull();
  });

  it('paid + receipt rendered (hasReceiptPdf=true, raw=null) shows the combined-mode hint', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
      }),
    ]);
    // The aria-labelled hint span IS present…
    const hint = screen.getByLabelText(COMBINED_HINT_LABEL);
    expect(hint).toBeInTheDocument();
    // …and it carries the InfoIcon decoration (aria-hidden; the aria-label
    // on the wrapper conveys the meaning to assistive tech).
    expect(hint.querySelector('svg.lucide-info')).not.toBeNull();
    // No raw receipt number text leaks into the cell.
    expect(screen.queryByText('RC-2026-0001')).not.toBeInTheDocument();
  });

  it('separate-mode (receiptDocumentNumberRaw set) shows the raw receipt number, not the hint', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0001',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    // First branch: the raw §87 RC number is rendered verbatim.
    expect(screen.getByText('RC-2026-0001')).toBeInTheDocument();
    // …and the combined-mode hint is NOT shown (separate mode owns a
    // distinct receipt document number, so there is nothing to disambiguate).
    expect(screen.queryByLabelText(COMBINED_HINT_LABEL)).toBeNull();
  });
});
