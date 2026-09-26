/**
 * Void copy selection by tax-document kind (pure).
 *
 * The generic void copy says the invoice's "sequential tax-document number is
 * retired". That is true for a legacy §86/4 INV- invoice (kind `none` — its §87
 * number was allocated at issue) and for a paid 088 bill whose RC §86/4 tax
 * receipt was voided (kind `tax_receipt`). It is FALSE for an unpaid 088
 * ใบแจ้งหนี้ bill (kind `bill`, SC-…): a bill is not a tax document and never
 * carried a §87 / §86/4 number, so it gets bill-aware copy — the bill number
 * stays on record, stamped VOID, never reused; no tax-receipt number involved.
 *
 * Callers pass `resolveTaxDocumentKind(invoice, true)`: the ROW SHAPE decides
 * (void itself is row-shape dispatched, not flag-gated), so a bill issued while
 * the 088 flag was on still gets the bill copy if the flag is later turned off.
 *
 * Returns keys relative to `admin.invoices.void` / `admin.invoices.detail.voidDetails`.
 */
export type VoidCopyDocKind = 'none' | 'bill' | 'tax_receipt';

export function voidDescriptionKey(kind: VoidCopyDocKind): 'description' | 'descriptionBill' {
  return kind === 'bill' ? 'descriptionBill' : 'description';
}

export function voidDetailsHintKey(
  kind: VoidCopyDocKind,
): 'creditNoteHint' | 'creditNoteHintBill' {
  return kind === 'bill' ? 'creditNoteHintBill' : 'creditNoteHint';
}
