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
