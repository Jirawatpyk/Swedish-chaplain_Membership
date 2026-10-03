/**
 * 122 US8b (T828) — sample data for the preview's invoice detail views, as
 * the `Admin-invoice-*`, `Admin-voided`, `Admin-refund-*` boards draw them.
 * Figures, names and numbers are sample values, never a tenant's.
 */
import type { CreditNote, Invoice, InvoiceSupersessionLink } from '@/modules/invoicing';
import type { InvoiceDetailViewProps } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/invoice-detail-view';

export const DETAIL_INVOICE_ID = '00000000-0000-4000-8000-0000000000a1';
export const DETAIL_TODAY_ISO = '2026-10-02';

export type DetailFixtureKind =
  | 'draft'
  | 'issued'
  | 'overdue'
  | 'paid'
  | 'credited'
  | 'manager'
  | 'email-failed'
  | 'auto-refund-failed'
  | 'refund-settling'
  | 'refund-partial'
  | 'refund-full'
  | 'refund-receipt'
  | 'voided'
  | 'as-paid-tin'
  | 'as-paid-receipt';

const money = (satang: bigint) => ({ satang });
const SUBTOTAL = 3_600_000n;
const VAT = 252_000n;
const TOTAL = 3_852_000n;

function invoice(over: Record<string, unknown> = {}): Invoice {
  return {
    invoiceId: DETAIL_INVOICE_ID,
    tenantId: 'swecham',
    status: 'issued',
    invoiceSubject: 'membership',
    memberId: '00000000-0000-4000-8000-000000000003',
    planId: 'premium',
    planYear: 2026,
    documentNumber: null,
    billDocumentNumberRaw: 'SC-2026-000123',
    receiptDocumentNumberRaw: null,
    issueDate: '2026-09-15',
    dueDate: '2026-10-15',
    subtotal: money(SUBTOTAL),
    vat: money(VAT),
    total: money(TOTAL),
    creditedTotal: money(0n),
    vatRate: { toPercentString: () => '7.00%' },
    pdf: { key: 'preview' },
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
    memberIdentitySnapshot: { legal_name: 'Siam Nordic Trading Co., Ltd.' },
    lines: [
      {
        lineId: 'l-1',
        descriptionTh: 'ค่าสมาชิกรายปี Premium Corporate ปี 2569',
        descriptionEn: 'Premium Corporate annual membership 2026',
        quantity: 1,
        unitPrice: money(SUBTOTAL),
        total: money(SUBTOTAL),
      },
    ],
    ...over,
  } as unknown as Invoice;
}

const PAID = {
  status: 'paid',
  receiptDocumentNumberRaw: 'RC-2026-000088',
  receiptPdf: { key: 'preview-receipt' },
  paidAt: '2026-09-20T03:12:00.000Z',
  paymentDate: '2026-09-20',
  paymentMethod: 'bank_transfer',
  paymentReference: 'KBANK 4471-0920',
  paymentRecordedByUserId: 'u-malin',
};

const CREDIT_NOTE = {
  creditNoteId: 'cn-1',
  documentNumber: { raw: 'CN-2026-000012' },
  issueDate: '2026-09-25',
  reason: 'Duplicate event seat charged on the membership bill',
  total: money(535_000n),
} as unknown as CreditNote;

const REPLACEMENT: InvoiceSupersessionLink = {
  invoiceId: '00000000-0000-4000-8000-0000000000a2',
  displayNumber: 'SC-2026-000131',
  issueDate: '2026-09-22',
  status: 'issued',
} as InvoiceSupersessionLink;

const BASE: Omit<InvoiceDetailViewProps, 'invoice' | 'displayStatus' | 'paymentActivity'> = {
  routeSegment: DETAIL_INVOICE_ID,
  headerNumber: 'SC-2026-000123',
  displayNumber: null,
  taxDocKind: 'bill',
  voidedBill: null,
  memberDisplayName: 'Siam Nordic Trading Co., Ltd.',
  planDisplayName: 'Premium Corporate',
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
  totals: { subtotalSatang: SUBTOTAL, vatSatang: VAT, totalSatang: TOTAL, vatPercent: '7.00%' },
  settlingRefundSatang: null,
  refund: null,
  bangkokTodayIso: DETAIL_TODAY_ISO,
  taxAtPayment: true,
  locale: 'en',
};

/** The succeeded payment the refund dialog names: 38,520.00 THB on 20 Sep. */
const REFUND_PAY_1 = {
  paymentId: 'pay-1',
  remainingRefundableSatang: TOTAL,
  pendingRefundExists: false,
  paidAmountSatang: TOTAL,
  paidAt: '2026-09-20T03:12:00.000Z',
};

const paidProps = (over: Partial<InvoiceDetailViewProps> = {}): Omit<InvoiceDetailViewProps, 'paymentActivity' | 'locale'> => ({
  ...BASE,
  invoice: invoice(PAID),
  displayStatus: 'paid',
  displayNumber: 'RC-2026-000088',
  taxDocKind: 'tax_receipt',
  hasReceiptPdf: true,
  paymentRecordedByEmail: 'malin.berg@example.com',
  paymentDetails: { methodKey: 'bank_transfer', notes: 'Transfer matched on the 20 Sep statement' } as InvoiceDetailViewProps['paymentDetails'],
  refund: REFUND_PAY_1,
  ...over,
});

/** The view's props per state, less the locale and the payment-activity slot the route fills. */
export function detailFixture(kind: DetailFixtureKind): Omit<InvoiceDetailViewProps, 'paymentActivity' | 'locale'> {
  switch (kind) {
    case 'draft':
      return {
        ...BASE,
        invoice: invoice({ status: 'draft', billDocumentNumberRaw: null, issueDate: null, dueDate: null, pdf: null }),
        displayStatus: 'draft',
        headerNumber: null,
        taxDocKind: 'none',
      };
    case 'overdue':
      return {
        ...BASE,
        invoice: invoice({ issueDate: '2026-08-15', dueDate: '2026-09-14' }),
        displayStatus: 'overdue',
      };
    case 'manager':
      return { ...BASE, invoice: invoice(), displayStatus: 'issued', isAdmin: false };
    case 'email-failed':
      return {
        ...BASE,
        invoice: invoice(),
        displayStatus: 'issued',
        failedEmailBanners: [{ variant: 'invoice', recipientEmail: 'erik.johansson@siamnordic.example', canResend: true }],
      };
    case 'paid':
    // `Admin-refund-full`: the paid invoice, nothing credited yet.
    case 'refund-full':
      return paidProps();
    // A §105 receipt (event, buyer not VAT-registered) being refunded: no
    // credit note is owed, so the dialog draws no VAT rows.
    case 'refund-receipt':
      return paidProps({
        invoice: invoice({ ...PAID, invoiceSubject: 'event', billDocumentNumberRaw: null, receiptDocumentNumberRaw: 'RE-2026-000007', receiptPdf: null, pdfDocKind: 'receipt_separate' }),
        headerNumber: 'RE-2026-000007',
        displayNumber: 'RE-2026-000007',
        taxDocKind: 'none',
        planDisplayName: '',
        buyerHasTaxId: false,
        hasReceiptPdf: false,
      });
    case 'refund-partial':
      return paidProps({
        invoice: invoice({ ...PAID, status: 'partially_credited', creditedTotal: money(535_000n) }),
        displayStatus: 'partially_credited',
        creditNotes: [CREDIT_NOTE],
        refund: { ...REFUND_PAY_1, remainingRefundableSatang: TOTAL - 535_000n },
      });
    case 'refund-settling':
      return paidProps({
        settlingRefundSatang: 535_000n,
        refund: { ...REFUND_PAY_1, pendingRefundExists: true },
      });
    case 'auto-refund-failed':
      return paidProps({ autoRefund: { failed: true, processorRefundId: 're_3PreviewFailed01' } });
    case 'credited':
      return paidProps({
        invoice: invoice({ ...PAID, status: 'partially_credited', creditedTotal: money(535_000n) }),
        displayStatus: 'partially_credited',
        creditNotes: [CREDIT_NOTE],
      });
    case 'voided':
      return {
        ...BASE,
        invoice: invoice({
          status: 'void',
          voidedAt: '2026-09-22T02:40:00.000Z',
          voidedByUserId: 'u-malin',
          voidReason: 'Issued to the wrong legal entity; reissued to the Thai subsidiary',
        }),
        displayStatus: 'void',
        voidedBill: 'SC-2026-000123',
        voidedByEmail: 'malin.berg@example.com',
        replacedBy: REPLACEMENT,
      };
    // The event-fee already-paid flow: no bill, one document (heading by type).
    case 'as-paid-tin':
      return paidProps({
        invoice: invoice({ ...PAID, invoiceSubject: 'event', billDocumentNumberRaw: null, documentNumber: { raw: 'INV-2026-000041' }, receiptDocumentNumberRaw: null, receiptPdf: null, pdfDocKind: 'receipt_combined' }),
        headerNumber: 'INV-2026-000041',
        displayNumber: 'INV-2026-000041',
        taxDocKind: 'none',
        planDisplayName: '',
        hasReceiptPdf: false,
        refund: null,
      });
    case 'as-paid-receipt':
      return paidProps({
        invoice: invoice({ ...PAID, invoiceSubject: 'event', billDocumentNumberRaw: null, receiptDocumentNumberRaw: 'RE-2026-000007', receiptPdf: null, pdfDocKind: 'receipt_separate' }),
        headerNumber: 'RE-2026-000007',
        displayNumber: 'RE-2026-000007',
        taxDocKind: 'none',
        planDisplayName: '',
        buyerHasTaxId: false,
        hasReceiptPdf: false,
        refund: null,
      });
    case 'issued':
    default:
      return { ...BASE, invoice: invoice(), displayStatus: 'issued' };
  }
}

export const DETAIL_KINDS: readonly DetailFixtureKind[] = [
  'draft',
  'issued',
  'overdue',
  'paid',
  'credited',
  'manager',
  'email-failed',
  'auto-refund-failed',
  'refund-settling',
  'refund-partial',
  'refund-full',
  'refund-receipt',
  'voided',
  'as-paid-tin',
  'as-paid-receipt',
];
