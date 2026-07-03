/**
 * 088 T071a / FR-030 — unit coverage for the member-detail invoice-row number
 * resolver. Guards the "document_number-NULL sweep": an issued 088 ใบแจ้งหนี้
 * (SC bill number in `billDocumentNumberRaw`, §87 `documentNumber` NULL until
 * payment) MUST surface its SC number, NOT the "(draft)" placeholder.
 *
 * Pre-fix RED: the section read `inv.documentNumber?.raw` directly, so the
 * `issued 088 bill` case resolved to `null` (→ draft placeholder). This suite
 * pins the corrected bill-first resolution.
 */
import { describe, expect, it } from 'vitest';
import type { Invoice } from '@/modules/invoicing';
import type { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { resolveMemberInvoiceDisplayNumber } from '@/app/(staff)/admin/members/[memberId]/_components/resolve-invoice-display-number';

/** A DocumentNumber VO stub — the resolver only reads `.raw`. */
function docNum(raw: string): DocumentNumber {
  return { raw } as DocumentNumber;
}

type Row = Pick<Invoice, 'billDocumentNumberRaw' | 'documentNumber'>;

describe('resolveMemberInvoiceDisplayNumber (088 FR-030)', () => {
  it('issued 088 bill → the SC bill number (not the §87 documentNumber, which is NULL)', () => {
    const row: Row = { billDocumentNumberRaw: 'SC-2026-000123', documentNumber: null };
    expect(resolveMemberInvoiceDisplayNumber(row)).toBe('SC-2026-000123');
  });

  it('paid 088 bill → keeps the SC bill number as the row identity (documentNumber stays NULL)', () => {
    // A paid 088 invoice never fills `documentNumber` (the §87 RC lives in
    // `receiptDocumentNumberRaw`); the row identity remains its SC bill number.
    const row: Row = { billDocumentNumberRaw: 'SC-2026-000123', documentNumber: null };
    expect(resolveMemberInvoiceDisplayNumber(row)).toBe('SC-2026-000123');
  });

  it('legacy §87 row → the documentNumber.raw (bill number NULL on pre-088 rows)', () => {
    const row: Row = { billDocumentNumberRaw: null, documentNumber: docNum('INV-2026-0001') };
    expect(resolveMemberInvoiceDisplayNumber(row)).toBe('INV-2026-0001');
  });

  it('true draft → null (both numbers absent; caller supplies its own placeholder)', () => {
    const row: Row = { billDocumentNumberRaw: null, documentNumber: null };
    expect(resolveMemberInvoiceDisplayNumber(row)).toBeNull();
  });

  it('never String()s the DocumentNumber VO ([object Object] trap)', () => {
    const row: Row = { billDocumentNumberRaw: null, documentNumber: docNum('INV-2026-0009') };
    expect(resolveMemberInvoiceDisplayNumber(row)).not.toContain('[object Object]');
  });
});
