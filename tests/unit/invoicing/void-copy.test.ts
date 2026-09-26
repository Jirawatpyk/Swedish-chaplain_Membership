/**
 * Void copy is document-aware: an 088 ใบแจ้งหนี้ bill (SC-…) was never a §87
 * tax document, so its void copy must NOT say a "sequential tax-document number
 * is retired". A legacy INV- §86/4 invoice (kind 'none') and a paid bill whose
 * RC §86/4 receipt was voided (kind 'tax_receipt') keep the tax-document copy.
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import {
  voidDescriptionKey,
  voidDetailsHintKey,
} from '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-copy';

describe('void copy selection by tax-document kind', () => {
  it('an 088 bill gets the bill-aware void-page description', () => {
    expect(voidDescriptionKey('bill')).toBe('descriptionBill');
  });

  it('a legacy §86/4 invoice (none) and a tax-receipt row keep the tax-document description', () => {
    expect(voidDescriptionKey('none')).toBe('description');
    expect(voidDescriptionKey('tax_receipt')).toBe('description');
  });

  it('the voided-invoice hint follows the same split', () => {
    expect(voidDetailsHintKey('bill')).toBe('creditNoteHintBill');
    expect(voidDetailsHintKey('none')).toBe('creditNoteHint');
    expect(voidDetailsHintKey('tax_receipt')).toBe('creditNoteHint');
  });
});
