/**
 * Spec 122 US8b follow-up — the credit-note verdict the invoice detail page
 * reads before the refund dialog opens (so its description never promises a
 * credit note F4 waives). The same composition `previewRefundCreditNote` and
 * the refund pre-flight use.
 */
import { describe, expect, it } from 'vitest';
import {
  refundCreditNoteRequirementFor,
  refundCreditNoteWaiverReasonFor,
} from '@/modules/invoicing/application/use-cases/refund-credit-note-verdict';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';

const TOTAL = 3_852_000n;
const VAT = 252_000n;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId('inv-1'),
    memberId: 'm-1',
    planId: 'p',
    planYear: 2026,
    invoiceSubject: 'membership',
    vatInclusive: false,
    eventId: null,
    eventRegistrationId: null,
    status: 'paid',
    draftByUserId: 'u',
    fiscalYear: null,
    sequenceNumber: null,
    documentNumber: null,
    issueDate: null,
    dueDate: null,
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(TOTAL - VAT),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(VAT),
    total: Money.fromSatangUnsafe(TOTAL),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: null,
    tenantIdentitySnapshot: null,
    memberIdentitySnapshot: { legal_name: 'Acme AB', buyer_is_vat_registrant: true },
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: null,
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: 'rendered',
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-04-18T00:00:00Z',
    updatedAt: '2026-04-18T00:00:00Z',
    ...overrides,
  } as Invoice;
}

describe('refundCreditNoteWaiverReasonFor', () => {
  it('an ordinary paid membership invoice owes a credit note — no waiver', () => {
    expect(refundCreditNoteWaiverReasonFor(makeInvoice())).toBeNull();
    expect(refundCreditNoteRequirementFor(makeInvoice()).kind).toBe('issue');
  });

  it('a §105 receipt (event, buyer not VAT-registered) is waived', () => {
    const inv = makeInvoice({
      invoiceSubject: 'event',
      memberIdentitySnapshot: { legal_name: 'Small Co', buyer_is_vat_registrant: false } as Invoice['memberIdentitySnapshot'],
    });
    expect(refundCreditNoteWaiverReasonFor(inv)).toBe('section_105_receipt');
  });

  it('a voided invoice is waived', () => {
    expect(refundCreditNoteWaiverReasonFor(makeInvoice({ status: 'void' }))).toBe('invoice_voided');
  });

  it('a blocked gate is not a waiver (the refund is refused on its own)', () => {
    expect(refundCreditNoteWaiverReasonFor(makeInvoice({ receiptPdfStatus: 'pending' }))).toBeNull();
    expect(refundCreditNoteWaiverReasonFor(makeInvoice({ invoiceSubject: 'event', memberIdentitySnapshot: null }))).toBeNull();
  });
});
