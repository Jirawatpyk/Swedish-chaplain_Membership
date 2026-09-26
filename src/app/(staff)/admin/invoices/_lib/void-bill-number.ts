/**
 * 088 — which void wording an invoice gets.
 *
 * An unpaid 088 ใบแจ้งหนี้ bill is identified by a NON-§87 bill number (SC-…)
 * and never used a sequential tax-document number, so the void page and the
 * voided-invoice panel must not tell staff that one "is retired". Returns the
 * bill number to show in the bill wording, or `null` for the tax-document
 * wording (a legacy §87 invoice, or a bill that already has its §86/4 RC).
 */
import { resolveTaxDocumentKind } from '@/modules/invoicing';

export function voidedBillNumber(
  inv: {
    readonly billDocumentNumberRaw: string | null;
    readonly receiptDocumentNumberRaw: string | null;
  },
  taxAtPaymentFlagOn: boolean,
): string | null {
  return resolveTaxDocumentKind(inv, taxAtPaymentFlagOn) === 'bill'
    ? inv.billDocumentNumberRaw
    : null;
}
