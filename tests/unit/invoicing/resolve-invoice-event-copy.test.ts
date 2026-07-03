/**
 * Unit tests for `resolveInvoiceEventCopy` — US7 AS2 copy mapper.
 *
 * The resolver is a pure Application-layer function — every branch is
 * exercisable without a DB, framework, or network. 10 tests walk the
 * full event-type matrix + the null-payload + non-F4 fall-through
 * branches so Domain 100%-line coverage holds.
 */
import { describe, expect, it } from 'vitest';
import { resolveInvoiceEventCopy } from '@/modules/members/application/timeline/resolve-invoice-event-copy';

const INVOICE_ID = '00000000-0000-4000-8000-000000000001';
const CREDIT_NOTE_ID = '00000000-0000-4000-8000-000000000002';

describe('resolveInvoiceEventCopy', () => {
  it('returns null for an unknown event type', () => {
    expect(resolveInvoiceEventCopy('nothing_like_an_f4_event', {})).toBeNull();
  });

  it('returns null for a non-F4 member event', () => {
    // `member_created` is a real F3 event but not in the F4 timeline
    // subset — must fall through to the generic renderer.
    expect(
      resolveInvoiceEventCopy('member_created', { member_id: 'm-1' }),
    ).toBeNull();
  });

  it('invoice_draft_created: link points to /admin/invoices/<id>, no docNumber', () => {
    const copy = resolveInvoiceEventCopy('invoice_draft_created', {
      invoice_id: INVOICE_ID,
      member_id: 'm-1',
    });
    expect(copy).not.toBeNull();
    expect(copy?.i18nKey).toBe('invoiceDraftCreated');
    expect(copy?.link).toBe(`/admin/invoices/${INVOICE_ID}`);
    expect(copy?.vars.documentNumber).toBeUndefined();
  });

  it('invoice_issued: vars include documentNumber and totalSatang', () => {
    const copy = resolveInvoiceEventCopy('invoice_issued', {
      invoice_id: INVOICE_ID,
      document_number: 'INV-2026-0042',
      total_satang: '107000',
    });
    expect(copy?.i18nKey).toBe('invoiceIssued');
    expect(copy?.vars.documentNumber).toBe('INV-2026-0042');
    expect(copy?.vars.totalSatang).toBe('107000');
    expect(copy?.link).toBe(`/admin/invoices/${INVOICE_ID}`);
  });

  it('invoice_issued (088 bill): documentNumber falls back to bill_document_number_raw when §87 document_number is NULL', () => {
    // 088 (FR-030) — an issued 088 ใบแจ้งหนี้ has NULL §87 `document_number`;
    // its SC bill number is emitted as `bill_document_number_raw`
    // (issue-invoice.ts audit payload). Without the fallback, the timeline
    // renders `invoiceIssued` with a MISSING {documentNumber}.
    const copy = resolveInvoiceEventCopy('invoice_issued', {
      invoice_id: INVOICE_ID,
      document_number: null,
      bill_document_number_raw: 'SC-2026-000045',
    });
    expect(copy?.i18nKey).toBe('invoiceIssued');
    expect(copy?.vars.documentNumber).toBe('SC-2026-000045');
  });

  it('invoice_paid without document_number OR receipt_document_number: vars.documentNumber undefined', () => {
    const copy = resolveInvoiceEventCopy('invoice_paid', {
      invoice_id: INVOICE_ID,
      payment_method: 'bank_transfer',
    });
    expect(copy?.i18nKey).toBe('invoicePaid');
    expect(copy?.vars.documentNumber).toBeUndefined();
    expect(copy?.vars.paymentMethod).toBe('bank_transfer');
  });

  it('invoice_paid: vars include paymentMethod + receipt_document_number fallback', () => {
    const copy = resolveInvoiceEventCopy('invoice_paid', {
      invoice_id: INVOICE_ID,
      payment_method: 'bank_transfer',
      receipt_document_number: 'RCT-2026-0042',
    });
    expect(copy?.i18nKey).toBe('invoicePaid');
    expect(copy?.vars.paymentMethod).toBe('bank_transfer');
    // Falls back to receipt_document_number when document_number absent.
    expect(copy?.vars.documentNumber).toBe('RCT-2026-0042');
  });

  it('invoice_voided: vars include reason + link to invoice (not deleted)', () => {
    const copy = resolveInvoiceEventCopy('invoice_voided', {
      invoice_id: INVOICE_ID,
      reason: 'duplicate',
    });
    expect(copy?.i18nKey).toBe('invoiceVoided');
    expect(copy?.vars.reason).toBe('duplicate');
    expect(copy?.link).toBe(`/admin/invoices/${INVOICE_ID}`);
  });

  it('credit_note_issued: link points to /admin/credit-notes/<id>, NOT /admin/invoices/', () => {
    const copy = resolveInvoiceEventCopy('credit_note_issued', {
      credit_note_id: CREDIT_NOTE_ID,
      original_invoice_id: INVOICE_ID,
      document_number: 'CN-2026-0001',
      credit_amount_satang: '10000',
    });
    expect(copy?.i18nKey).toBe('creditNoteIssued');
    expect(copy?.link).toBe(`/admin/credit-notes/${CREDIT_NOTE_ID}`);
    expect(copy?.vars.creditAmountSatang).toBe('10000');
    // G-6 — also emits pre-divided decimal form for locale copy
    // (e.g., "ออกใบลดหนี้ … จำนวน {creditAmount} บาท"). Pure string;
    // no locale grouping, consumer applies locale-specific formatting.
    expect(copy?.vars.creditAmount).toBe('100.00');
  });

  it('invoice_pdf_resent: vars include documentNumber', () => {
    const copy = resolveInvoiceEventCopy('invoice_pdf_resent', {
      invoice_id: INVOICE_ID,
      document_number: 'INV-2026-0042',
    });
    expect(copy?.i18nKey).toBe('invoicePdfResent');
    expect(copy?.vars.documentNumber).toBe('INV-2026-0042');
  });

  it('tax_receipt_issued (088/FR-029): i18nKey taxReceiptIssued, RC number from receipt_document_number_raw, link to the invoice (RC document)', () => {
    // The §86/4 tax-receipt-at-payment event carries the §87 `RC` number in
    // `receipt_document_number_raw` (record-payment.ts emit payload) — NOT the
    // `document_number` / `receipt_document_number` keys the older events use.
    const copy = resolveInvoiceEventCopy('tax_receipt_issued', {
      invoice_id: INVOICE_ID,
      receipt_document_number_raw: 'RC-2026-000045',
      member_id: 'm-1',
    });
    expect(copy).not.toBeNull();
    expect(copy?.i18nKey).toBe('taxReceiptIssued');
    expect(copy?.vars.documentNumber).toBe('RC-2026-000045');
    // The RC receipt is downloaded from the invoice detail surface — link there.
    expect(copy?.link).toBe(`/admin/invoices/${INVOICE_ID}`);
  });

  it('tax_receipt_issued: non-member event buyer (no member_id) still resolves + interpolates RC', () => {
    const copy = resolveInvoiceEventCopy('tax_receipt_issued', {
      invoice_id: INVOICE_ID,
      receipt_document_number_raw: 'RC-2026-000046',
      event_registration_id: 'reg-1',
    });
    expect(copy?.i18nKey).toBe('taxReceiptIssued');
    expect(copy?.vars.documentNumber).toBe('RC-2026-000046');
    expect(copy?.link).toBe(`/admin/invoices/${INVOICE_ID}`);
  });

  it('null payload does not throw; all link fields are null', () => {
    const copy = resolveInvoiceEventCopy('invoice_issued', null);
    expect(copy).not.toBeNull();
    expect(copy?.link).toBeNull();
    expect(copy?.vars.documentNumber).toBeUndefined();
  });

  it('total_satang as number coerces to string in vars', () => {
    const copy = resolveInvoiceEventCopy('invoice_issued', {
      invoice_id: INVOICE_ID,
      total_satang: 107000,
    });
    expect(copy?.vars.totalSatang).toBe('107000');
  });
});
