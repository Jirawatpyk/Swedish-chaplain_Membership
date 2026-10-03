/**
 * Spec 122 US8b (T822–T823) — the invoice detail page body in one view
 * function the page and the no-DB preview route both render, in the agreed
 * layout (board `Admin-voided`, spec Session 2026-10-02 US8b):
 *
 *   "Invoice {number}" (a draft reads "Draft invoice") with the status pill →
 *   the alerts → a Details card (fields, then the totals at its end) → Payment
 *   details → Voided → Credit notes → Line items → Payment activity, each in
 *   its own card.
 *
 * Amounts keep their `en-US` grouping and " THB" suffix; the fields keep
 * their gates (plan row on membership only, Receipt No. on a receipt-bearing
 * status, the payment card from paid on, the voided card on void).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { CreditNote, Invoice } from '@/modules/invoicing';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/invoices/inv-1',
  useSearchParams: () => new URLSearchParams(),
}));
// The actions and alerts are their own tasks (T824–T826); here only that the
// view places them matters.
vi.mock('@/app/(staff)/admin/invoices/_components/issue-invoice-dialog', () => ({
  IssueInvoiceDialog: () => <button type="button">Issue…</button>,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/delete-draft-dialog', () => ({
  DeleteDraftDialog: () => <button type="button">Delete draft…</button>,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/record-payment-dialog', () => ({
  RecordPaymentDialog: () => <button type="button" data-testid="record-payment-trigger">Record payment…</button>,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/invoice-more-menu', () => ({
  InvoiceMoreMenu: (p: { showVoid?: boolean }) => (
    <button type="button" data-show-void={p.showVoid ? 'true' : 'false'}>
      More
    </button>
  ),
}));
vi.mock('@/app/(staff)/admin/invoices/_components/email-failure-alert', () => ({
  EmailFailureAlert: (p: { variant: string }) => <div role="alert">email-failure-{p.variant}</div>,
}));
vi.mock('@/app/(staff)/admin/invoices/_components/auto-refund-failed-alert', () => ({
  AutoRefundFailedAlert: () => <div role="alert">auto-refund-failed</div>,
}));
vi.mock('@/app/(staff)/admin/invoices/[invoiceId]/_components/refund-dialog', () => ({
  RefundDialog: () => <button type="button">Issue refund…</button>,
}));
vi.mock('@/app/(staff)/admin/invoices/[invoiceId]/_components/issue-credit-note-action', () => ({
  IssueCreditNoteAction: () => <a href="#cn">Issue credit note…</a>,
}));
vi.mock('@/components/members/no-primary-contact-banner', () => ({
  NoPrimaryContactBanner: () => <div role="alert">no-primary-contact</div>,
}));

const { renderInvoiceDetailView } = await import(
  '@/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view'
);
type ViewProps = Parameters<typeof renderInvoiceDetailView>[0];

const money = (satang: bigint) => ({ satang });

function invoice(over: Record<string, unknown> = {}): Invoice {
  return {
    invoiceId: 'inv-1',
    tenantId: 'swecham',
    status: 'issued',
    invoiceSubject: 'membership',
    memberId: 'm-1',
    planId: 'gold-partnership',
    planYear: 2027,
    documentNumber: null,
    billDocumentNumberRaw: 'SC-2026-000130',
    receiptDocumentNumberRaw: null,
    issueDate: '2026-09-22',
    dueDate: '2026-10-22',
    subtotal: money(10_000_000n),
    vat: money(700_000n),
    total: money(10_700_000n),
    creditedTotal: money(0n),
    vatRate: { toPercentString: () => '7.00%' },
    pdf: { key: 'k' },
    receiptPdf: null,
    pdfDocKind: 'invoice',
    paidAt: null,
    paymentDate: null,
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    voidedAt: null,
    voidedByUserId: null,
    voidReason: null,
    tenantIdentitySnapshot: { currency_code: 'THB' },
    memberIdentitySnapshot: { legal_name: 'Lindqvist & Chai Group Co., Ltd.' },
    lines: [
      {
        lineId: 'l-1',
        descriptionTh: 'ค่าสมาชิก SweCham พาร์ทเนอร์ระดับทอง ปี 2570',
        descriptionEn: 'SweCham Gold Partnership Membership Fee 2027',
        quantity: 1,
        unitPrice: money(10_000_000n),
        total: money(10_000_000n),
      },
    ],
    ...over,
  } as unknown as Invoice;
}

function props(over: Partial<ViewProps> = {}): ViewProps {
  const inv = over.invoice ?? invoice();
  return {
    invoice: inv,
    routeSegment: 'inv-1',
    displayStatus: inv.status,
    headerNumber: 'SC-2026-000130',
    displayNumber: null,
    taxDocKind: 'bill',
    voidedBill: null,
    memberDisplayName: 'Lindqvist & Chai Group Co., Ltd.',
    planDisplayName: 'Gold Partnership',
    buyerHasTaxId: true,
    buyerIsVatRegistrant: true,
    showNoPrimaryContactBanner: false,
    paymentRecordedByEmail: '—',
    voidedByEmail: '—',
    paymentDetails: { methodKey: null, notes: null },
    creditNotes: [],
    replacedBy: null,
    replaces: [],
    isAdmin: true,
    hasReceiptPdf: false,
    failedEmailBanners: [],
    autoRefund: { failed: false, processorRefundId: null },
    totals: { subtotalSatang: 10_000_000n, vatSatang: 700_000n, totalSatang: 10_700_000n, vatPercent: '7.00%' },
    refundSettling: false,
    refund: null,
    bangkokTodayIso: '2026-10-02',
    taxAtPayment: true,
    locale: 'en',
    paymentActivity: <section aria-label="Payment activity">activity</section>,
    ...over,
  };
}

async function view(p: ViewProps) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {(await renderInvoiceDetailView(p)) as ReactElement}
    </NextIntlClientProvider>,
  );
}

/** The page's cards, top to bottom, by their headings (the payment activity slot last). */
function cardHeadings(): string[] {
  return [...document.querySelectorAll('.aura-card .aura-card__title')].map((h) => h.textContent?.trim() ?? '');
}

describe('invoice detail — header', () => {
  it('reads "Invoice {number}" with the status pill in the list\'s tone', async () => {
    await view(props());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Invoice SC-2026-000130$/);
    const pill = screen.getByRole('heading', { level: 1 }).parentElement!.querySelector('.aura-pill');
    expect(pill).toHaveClass('aura-pill--progress');
    expect(pill).toHaveTextContent(/^Issued$/);
  });

  it('reads "Draft invoice" for a draft, with a neutral pill', async () => {
    const inv = invoice({ status: 'draft', billDocumentNumberRaw: null, issueDate: null, dueDate: null, pdf: null });
    await view(props({ invoice: inv, displayStatus: 'draft', headerNumber: null, taxDocKind: 'none' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Draft invoice$/);
    expect(document.querySelector('.aura-pill')).toHaveClass('aura-pill--neutral');
  });

  // Maintainer, 3 Oct: the heading names the document by its type. An 088
  // bill is always "Invoice {SC}"; the event-fee already-paid flow issues no
  // bill, only a combined tax invoice/receipt (TIN) or a §105 receipt (no TIN).
  it('names a paid 088 bill "Invoice {SC}", never by its receipt', async () => {
    const inv = invoice({ status: 'paid', receiptDocumentNumberRaw: 'RC-2026-000088', pdfDocKind: 'invoice' });
    await view(props({ invoice: inv, displayStatus: 'paid', headerNumber: 'SC-2026-000130', displayNumber: 'RC-2026-000088', taxDocKind: 'tax_receipt' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Invoice SC-2026-000130$/);
  });

  it('names an already-paid event fee for a TIN buyer as the combined tax invoice/receipt', async () => {
    const inv = invoice({ status: 'paid', invoiceSubject: 'event', billDocumentNumberRaw: null, documentNumber: { raw: 'INV-2026-000041' }, pdfDocKind: 'receipt_combined' });
    await view(props({ invoice: inv, displayStatus: 'paid', headerNumber: 'INV-2026-000041', displayNumber: 'INV-2026-000041', taxDocKind: 'none' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Tax invoice\/receipt INV-2026-000041$/);
  });

  it('names an already-paid event fee for a buyer with no TIN as the receipt', async () => {
    const inv = invoice({ status: 'paid', invoiceSubject: 'event', billDocumentNumberRaw: null, receiptDocumentNumberRaw: 'RE-2026-000007', pdfDocKind: 'receipt_separate' });
    await view(props({ invoice: inv, displayStatus: 'paid', headerNumber: 'RE-2026-000007', displayNumber: 'RE-2026-000007', taxDocKind: 'none' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Receipt RE-2026-000007$/);
  });

  it('shows an overdue invoice\'s pill as blocked', async () => {
    await view(props({ displayStatus: 'overdue' }));
    expect(document.querySelector('.aura-pill')).toHaveClass('aura-pill--blocked');
  });
});

describe('invoice detail — the Details card', () => {
  it('holds the fields, then the totals at its end, with the amounts as before', async () => {
    await view(props());
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('Member')).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: 'Lindqvist & Chai Group Co., Ltd.' })).toHaveAttribute('href', '/admin/members/m-1');
    expect(within(details).getByText('Plan / Year')).toBeInTheDocument();
    const totals = details.querySelector('[data-slot="invoice-totals"]') as HTMLElement;
    expect(totals).not.toBeNull();
    // the last thing in the card
    expect(totals.compareDocumentPosition(within(details).getByText('Due date')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(totals).getByText('100,000.00 THB')).toBeInTheDocument();
    expect(within(totals).getByText('7,000.00 THB')).toBeInTheDocument();
    expect(within(totals).getByText('107,000.00 THB')).toBeInTheDocument();
    expect(within(totals).getByText(/\(7\.00%\)/)).toBeInTheDocument();
  });

  it('labels a draft\'s total as a preview', async () => {
    const inv = invoice({ status: 'draft', billDocumentNumberRaw: null, pdf: null });
    await view(props({ invoice: inv, displayStatus: 'draft', headerNumber: null, taxDocKind: 'none' }));
    const totals = document.querySelector('[data-slot="invoice-totals"]') as HTMLElement;
    expect(within(totals).getByText(/\(preview\)/)).toBeInTheDocument();
  });

  it('leaves out the plan row on an event invoice and the member link for a non-member buyer', async () => {
    const inv = invoice({ invoiceSubject: 'event', memberId: null, planId: null, planYear: null });
    await view(props({ invoice: inv, memberDisplayName: 'Visiting Buyer Ltd.' }));
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).queryByText('Plan / Year')).toBeNull();
    expect(within(details).queryByRole('link', { name: 'Visiting Buyer Ltd.' })).toBeNull();
    expect(within(details).getByText('Visiting Buyer Ltd.')).toBeInTheDocument();
  });
});

describe('invoice detail — the cards in order', () => {
  it('an issued invoice: Details, Line items, then the payment activity', async () => {
    await view(props());
    expect(cardHeadings()).toEqual(['Details', 'Line items']);
    const lines = screen.getByRole('region', { name: 'Line items' });
    expect(lines.compareDocumentPosition(screen.getByRole('region', { name: 'Payment activity' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a paid invoice adds the Receipt No. and a Payment details card after Details', async () => {
    const inv = invoice({
      status: 'paid',
      receiptDocumentNumberRaw: 'RC-2026-000052',
      paymentDate: '2026-09-24',
      paidAt: '2026-09-24T03:00:00Z',
      paymentMethod: 'bank_transfer',
      paymentReference: 'KBANK 240926-8841',
    });
    await view(props({ invoice: inv, displayStatus: 'paid', hasReceiptPdf: true, paymentDetails: { methodKey: 'bank_transfer', notes: null }, paymentRecordedByEmail: 'johan.strand@swecham.example' }));
    expect(cardHeadings()).toEqual(['Details', 'Payment details', 'Line items']);
    expect(screen.getByTestId('invoice-receipt-number')).toHaveTextContent('RC-2026-000052');
    const pay = screen.getByRole('region', { name: 'Payment details' });
    expect(within(pay).getByText('Bank transfer')).toBeInTheDocument();
    expect(within(pay).getByText('KBANK 240926-8841')).toBeInTheDocument();
    expect(within(pay).getByText('johan.strand@swecham.example')).toBeInTheDocument();
  });

  it('a credited invoice lists its credit notes, with the total credited, before the line items', async () => {
    const inv = invoice({ status: 'partially_credited', creditedTotal: money(1_070_000n), receiptDocumentNumberRaw: 'RC-2026-000038' });
    const cn = {
      creditNoteId: 'cn-1',
      documentNumber: { raw: 'CN-2026-000014' },
      issueDate: '2026-09-23',
      reason: 'Charged the Premium rate',
      total: money(1_070_000n),
    } as unknown as CreditNote;
    await view(props({ invoice: inv, displayStatus: 'partially_credited', creditNotes: [cn], hasReceiptPdf: true }));
    expect(cardHeadings()).toEqual(['Details', 'Payment details', 'Credit notes (1)', 'Line items']);
    const cns = screen.getByRole('region', { name: 'Credit notes (1)' });
    expect(within(cns).getByText('CN-2026-000014')).toBeInTheDocument();
    expect(within(cns).getAllByText(/10,700\.00/).length).toBeGreaterThan(0);
    expect(within(cns).getByRole('link', { name: 'View credit note CN-2026-000014' })).toHaveAttribute('href', '/admin/credit-notes/cn-1');
    expect(within(cns).getByRole('link', { name: 'Download credit note CN-2026-000014 as PDF' })).toHaveAttribute('href', '/api/credit-notes/cn-1/pdf');
  });

  it('a voided invoice has a Voided card with who, when, why and the "Replaced by" link', async () => {
    const inv = invoice({ status: 'void', voidedAt: '2026-09-24T04:05:00Z', voidReason: 'Re-billed under the new company name' });
    await view(
      props({
        invoice: inv,
        displayStatus: 'void',
        voidedByEmail: 'malin.berg@swecham.example',
        voidedBill: 'SC-2026-000130',
        replacedBy: { invoiceId: 'inv-2', displayNumber: 'SC-2026-000140', status: 'issued', issueDate: '2026-09-24' } as never,
      }),
    );
    expect(cardHeadings()).toEqual(['Details', 'Voided', 'Line items']);
    const voided = screen.getByRole('region', { name: 'Voided' });
    expect(within(voided).getByText('malin.berg@swecham.example')).toBeInTheDocument();
    expect(within(voided).getByText('Re-billed under the new company name')).toBeInTheDocument();
    expect(within(voided).getByRole('link', { name: 'SC-2026-000140' })).toHaveAttribute('href', '/admin/invoices/inv-2');
  });
});

describe('invoice detail — the alerts sit above the Details card', () => {
  it('no primary contact, email delivery failed and auto-refund failed, for an admin', async () => {
    await view(
      props({
        showNoPrimaryContactBanner: true,
        failedEmailBanners: [{ variant: 'invoice', recipientEmail: 'a@b.example', canResend: true }],
        autoRefund: { failed: true, processorRefundId: 're_1' },
      }),
    );
    const details = screen.getByRole('region', { name: 'Details' });
    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toEqual(['no-primary-contact', 'email-failure-invoice', 'auto-refund-failed']);
    for (const a of alerts) expect(a.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a manager sees no email or auto-refund alert', async () => {
    await view(
      props({
        isAdmin: false,
        failedEmailBanners: [{ variant: 'invoice', recipientEmail: 'a@b.example', canResend: true }],
        autoRefund: { failed: true, processorRefundId: null },
      }),
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});

// Spec Session 2026-10-02 US8b — below 640px the header's own actions become
// a bar at the bottom of the screen, with the total and due date above them;
// they are drawn once, so every action keeps one trigger and its test id.
describe('invoice detail — the phone action bar', () => {
  it('wraps the actions once, with the total (incl. VAT) and due date for a phone', async () => {
    await view(props());
    const bar = document.querySelector('[data-slot="invoice-action-bar"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getAllByTestId('record-payment-trigger')).toHaveLength(1);
    expect(screen.getAllByTestId('record-payment-trigger')).toHaveLength(1);
    expect(within(bar).getByText('Total 107,000.00 THB incl. VAT · due 22 Oct 2026')).toHaveClass('sm:hidden');
  });

  it('gives the ⋯ menu Void… for a phone on an issued invoice the admin can void, hiding the header\'s Void there', async () => {
    await view(props());
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('data-show-void', 'true');
    expect(screen.getByTestId('void-invoice-trigger')).toHaveClass('max-sm:hidden');
  });

  it('a manager\'s menu gets no Void…', async () => {
    await view(props({ isAdmin: false }));
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('data-show-void', 'false');
    expect(screen.queryByTestId('void-invoice-trigger')).toBeNull();
  });

  it('draws no bar when there is nothing to put in it (a manager on a draft, a void bill with no PDF)', async () => {
    await view(props({ isAdmin: false, invoice: invoice({ status: 'draft', billDocumentNumberRaw: null }), displayStatus: 'draft', headerNumber: null }));
    expect(document.querySelector('[data-slot="invoice-action-bar"]')).toBeNull();
    document.body.innerHTML = '';
    await view(props({ isAdmin: false, invoice: invoice({ status: 'void', pdf: null }), displayStatus: 'void' }));
    expect(document.querySelector('[data-slot="invoice-action-bar"]')).toBeNull();
  });

  it('leaves room at the page end for the bar', async () => {
    await view(props());
    expect(document.querySelector('[data-slot="invoice-action-bar-spacer"]')).toHaveClass('sm:hidden');
  });
});
