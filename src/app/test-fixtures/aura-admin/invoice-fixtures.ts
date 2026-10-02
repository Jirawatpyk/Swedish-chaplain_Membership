/**
 * 122 US8a (T808) — sample data for the preview's invoice views, as the
 * `Admin-invoices` and `Admin-invoice-new` boards draw them. Figures,
 * names and numbers are sample values, never a tenant's.
 */
import type { InvoicesTableRow } from '@/app/(staff)/admin/invoices/_components/invoice-table';
import type { MemberOption, PlanOption } from '@/app/(staff)/admin/invoices/_components/invoice-form';
import type { EventOption } from '@/app/(staff)/admin/invoices/new/_components/event-fee-form';

/** Bangkok "today" for the per-row Record payment clamp. */
export const INVOICES_TODAY_ISO = '2026-09-30';

const base: Omit<InvoicesTableRow, 'invoiceId' | 'documentNumber' | 'status' | 'memberName' | 'totalSatang'> = {
  invoiceSubject: 'membership',
  buyerHasMemberLink: true,
  memberId: '00000000-0000-4000-8000-000000000003',
  buyerSubtitle: 'Membership 2026',
  issueDate: '2026-09-16',
  dueDate: '2026-10-16',
  hasPdf: true,
  creditNoteCount: 0,
  creditedTotalSatang: '0',
  onlinePaymentMethod: null,
  receiptDocumentNumberRaw: null,
  hasReceiptPdf: false,
  receiptPdfStatus: null,
  mainDownloadIsReceipt: false,
  mainDownloadIsBill: true,
  billDocumentNumberRaw: null,
  taxDocumentKind: 'bill',
};

export const INVOICE_ROWS: readonly InvoicesTableRow[] = [
  {
    ...base,
    invoiceId: 'inv-0131',
    documentNumber: 'SC-2026-000131',
    status: 'paid',
    memberName: 'Gamla Stan Coffee Roasters',
    issueDate: '2026-09-24',
    dueDate: '2026-10-24',
    totalSatang: '1070000',
    receiptDocumentNumberRaw: 'RC-2026-000052',
    hasReceiptPdf: true,
    receiptPdfStatus: 'rendered',
    billDocumentNumberRaw: 'SC-2026-000131',
    taxDocumentKind: 'tax_receipt',
  },
  {
    ...base,
    invoiceId: 'inv-0127',
    documentNumber: 'SC-2026-000127',
    status: 'issued',
    memberName: 'Baltic Bay Consulting Co., Ltd.',
    totalSatang: '2782000',
  },
  {
    ...base,
    invoiceId: 'inv-0123',
    documentNumber: 'SC-2026-000123',
    status: 'overdue',
    memberName: 'Lindqvist & Partners Co., Ltd.',
    issueDate: '2026-08-12',
    dueDate: '2026-09-11',
    totalSatang: '3852000',
  },
  {
    ...base,
    invoiceId: 'inv-0121',
    documentNumber: 'SC-2026-000121',
    status: 'paid',
    invoiceSubject: 'event',
    buyerHasMemberLink: false,
    memberId: '',
    memberName: 'Nordic Design House',
    buyerSubtitle: 'Crayfish Party 2026 · 2026-08-29',
    issueDate: '2026-08-20',
    dueDate: '2026-08-29',
    totalSatang: '160500',
    receiptDocumentNumberRaw: 'RC-2026-000049',
    receiptPdfStatus: 'pending',
    onlinePaymentMethod: 'promptpay',
    billDocumentNumberRaw: 'SC-2026-000121',
    taxDocumentKind: 'tax_receipt',
  },
  {
    ...base,
    invoiceId: 'inv-0110',
    documentNumber: 'SC-2026-000110',
    status: 'partially_credited',
    memberName: 'Siam Nordic Trading Co., Ltd.',
    issueDate: '2026-07-01',
    dueDate: '2026-07-31',
    totalSatang: '1712000',
    creditNoteCount: 1,
    creditedTotalSatang: '535000',
    receiptDocumentNumberRaw: 'RC-2026-000041',
    hasReceiptPdf: true,
    receiptPdfStatus: 'rendered',
    billDocumentNumberRaw: 'SC-2026-000110',
    taxDocumentKind: 'tax_receipt',
  },
  {
    ...base,
    invoiceId: 'inv-0104',
    documentNumber: 'SC-2026-000104',
    status: 'void',
    memberName: 'Uppsala Medtech Asia',
    issueDate: '2026-06-03',
    dueDate: '2026-07-03',
    totalSatang: '2140000',
  },
];

export const INVOICE_MEMBERS: readonly MemberOption[] = [
  { memberId: 'm-3', label: 'Siam Nordic Trading Co., Ltd. (Premium Corporate / 2026)', currentPlanId: 'premium-corporate', currentPlanYear: 2026 },
  { memberId: 'm-7', label: 'Baltic Bay Consulting Co., Ltd. (Regular Corporate / 2026)', currentPlanId: 'regular-corporate', currentPlanYear: 2026 },
];

export const INVOICE_PLANS: readonly PlanOption[] = [
  { planId: 'premium-corporate', label: 'Premium Corporate', annualFeeMinorUnits: 3_600_000 },
  { planId: 'regular-corporate', label: 'Regular Corporate', annualFeeMinorUnits: 2_600_000 },
];

export const INVOICE_EVENTS: readonly EventOption[] = [
  { eventId: 'ev-crayfish', label: 'Crayfish Party 2026 (2026-08-29)' },
  { eventId: 'ev-lucia', label: 'Lucia Celebration 2026 (2026-12-13)' },
];
