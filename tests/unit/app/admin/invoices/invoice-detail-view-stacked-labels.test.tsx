/**
 * Spec 122 US8b (parity check, 3 Oct) — the detail page's two tables stack
 * into cards on a phone, and each field cell names itself. AURA works a
 * stacked cell's label out from the matching header, but it cannot see the
 * headers when the table is rendered from a server file (the live page
 * showed bare numbers), so the view passes every field cell an explicit
 * `label`. The table parts are mocked to print only that prop.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
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

vi.mock('@/components/shell/aura-table', () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  THead: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  Tr: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  Th: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  Td: ({ children, label }: { children: React.ReactNode; label?: string }) => <td data-label={label}>{children}</td>,
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
    issueTotals: null,
    settlingRefundSatang: null,
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


describe('invoice detail — stacked table cells name themselves', () => {
  it('labels the line-item fields Qty, Unit and Total', async () => {
    await view(props());
    const cells = [...document.querySelectorAll('section[aria-labelledby="invoice-lines-heading"] tbody td')];
    expect(cells.map((c) => c.getAttribute('data-label')).slice(1)).toEqual(['Qty', 'Unit', 'Total']);
  });

  it('labels the credit-note fields Issued, Reason and Total', async () => {
    const inv = invoice({ status: 'partially_credited', creditedTotal: money(1_070_000n) });
    const cn = { creditNoteId: 'cn-1', documentNumber: { raw: 'CN-2026-000012' }, issueDate: '2026-09-25', reason: 'Seat refund', total: money(1_070_000n) } as unknown as CreditNote;
    await view(props({ invoice: inv, displayStatus: 'partially_credited', creditNotes: [cn] }));
    const row = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('CN-2026-000012'))!;
    expect([...row.querySelectorAll('td')].map((c) => c.getAttribute('data-label')).slice(1, 4)).toEqual(['Issued', 'Reason', 'Total']);
  });
});
