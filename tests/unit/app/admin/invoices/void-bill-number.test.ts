/**
 * 088 — void copy for an SC bill.
 *
 * An 088 ใบแจ้งหนี้ bill carries a NON-§87 bill number (SC-…); it never used a
 * sequential tax-document number. The void page and the voided-invoice panel
 * must therefore not say "the sequential tax-document number is retired" for
 * it. `voidedBillNumber` picks the bill wording (and the number to show) only
 * for a genuine unpaid 088 bill with the 088 flow on.
 */
import { describe, expect, it } from 'vitest';
import { voidedBillNumber } from '@/app/(staff)/admin/invoices/_lib/void-bill-number';

describe('voidedBillNumber', () => {
  it('returns the SC bill number for an unpaid 088 bill (flag on)', () => {
    expect(
      voidedBillNumber(
        { billDocumentNumberRaw: 'SC-2026-000007', receiptDocumentNumberRaw: null },
        true,
      ),
    ).toBe('SC-2026-000007');
  });

  it('returns null for a legacy §87 invoice (no bill number) — keeps the tax-document copy', () => {
    expect(
      voidedBillNumber({ billDocumentNumberRaw: null, receiptDocumentNumberRaw: null }, true),
    ).toBeNull();
  });

  it('returns null once a §86/4 receipt number exists (a real tax document is involved)', () => {
    expect(
      voidedBillNumber(
        { billDocumentNumberRaw: 'SC-2026-000007', receiptDocumentNumberRaw: 'RC-2026-000042' },
        true,
      ),
    ).toBeNull();
  });

  it('returns null with the 088 flow off', () => {
    expect(
      voidedBillNumber(
        { billDocumentNumberRaw: 'SC-2026-000007', receiptDocumentNumberRaw: null },
        false,
      ),
    ).toBeNull();
  });
});
