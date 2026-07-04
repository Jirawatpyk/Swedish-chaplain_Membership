/**
 * FIX 5 (Round-2 code-review) — shared §86/4 buyer-TIN / event-document-kind
 * discriminator.
 *
 * PURE Domain helper (zero framework imports). De-duplicates logic that was
 * repeated VERBATIM across three security-critical use-cases:
 *
 *   - issue-invoice.ts       — chooses the issue-time PDF kind
 *   - record-payment.ts      — gates `receipt_combined` vs `receipt_separate`
 *   - issue-credit-note.ts   — blocks crediting a §105 receipt
 *
 * Keeping the rule in ONE place eliminates the lockstep-divergence risk both
 * review rounds flagged: if the issue-time gate and the pay/credit-time gates
 * ever computed `buyerHasTin` differently, a TIN-less event buyer could be
 * issued a §105 ใบเสร็จรับเงิน yet later credited via a §86/10 ใบลดหนี้
 * (legally void), or a combined tax-invoice/receipt label could be applied to
 * a buyer who must never receive one.
 *
 * BEHAVIOUR (byte-identical to the former inline expressions):
 *   buyerHasTin(taxId)            === (taxId ?? '').trim() !== ''
 *   inferEventDocumentKind(s, t)  === (s === 'event' && !buyerHasTin(t))
 *                                       ? 'receipt_separate' : 'invoice'
 */

/**
 * Invoice subject discriminator. Mirrors `Invoice.invoiceSubject`
 * (`'membership' | 'event'`) — declared locally so this Domain helper carries
 * no import of the heavier aggregate type.
 */
export type InvoiceSubject = 'membership' | 'event';

/**
 * The two PDF document kinds this discriminator can resolve to. Both are a
 * strict subset of the Application-layer `PdfDocKind` union, so a use-case may
 * assign the result directly to a `PdfDocKind` without a cast.
 */
export type EventDocumentKind = 'invoice' | 'receipt_separate';

/**
 * True iff the resolved BUYER snapshot carries a (non-blank) tax id.
 *
 * Trims whitespace so a snapshot whose `tax_id` is `'   '` is treated as
 * absent — matching the legacy `(taxId ?? '').trim() !== ''` at all three
 * call-sites. Accepts `null`/`undefined` (the snapshot field is nullable).
 */
export function buyerHasTin(taxId: string | null | undefined): boolean {
  return (taxId ?? '').trim() !== '';
}

/**
 * Resolves the PDF document kind for an EVENT-subject invoice from the buyer's
 * tax id.
 *
 *   event + no TIN  → 'receipt_separate'  (ใบเสร็จรับเงิน / §105 receipt)
 *   event + TIN     → 'invoice'           (ใบกำกับภาษี / §86/4 tax invoice)
 *   membership      → 'invoice'           (ALWAYS a §86/4 ใบกำกับภาษี, with or
 *                                          without a buyer TIN — a non-registrant
 *                                          membership buyer gets a valid §86/4
 *                                          with name+address, TIN line absent
 *                                          [066 relax]. The discriminator never
 *                                          labels a membership doc as a §105
 *                                          receipt.)
 */
export function inferEventDocumentKind(
  subject: InvoiceSubject,
  taxId: string | null | undefined,
): EventDocumentKind {
  return subject === 'event' && !buyerHasTin(taxId)
    ? 'receipt_separate'
    : 'invoice';
}

/**
 * The two PAYMENT-TIME §105/§86-4 receipt kinds. Both are a strict subset of
 * the Application-layer `PdfDocKind` union.
 */
export type ReceiptDocumentKind = 'receipt_combined' | 'receipt_separate';

/**
 * 088-invoice-tax-flow-redesign (D13) — resolves the PAYMENT-TIME receipt PDF
 * kind from the invoice subject + buyer TIN. Distinct from
 * {@link inferEventDocumentKind} (which returns the ISSUE-time kind, where a
 * membership resolves to the non-tax `'invoice'` ใบแจ้งหนี้): at payment a
 * membership/event-with-TIN buyer receives the combined §86/4 + §105ทวิ
 * ใบกำกับภาษี/ใบเสร็จรับเงิน, while only an event-without-TIN buyer keeps the
 * §105 `receipt_separate` ใบเสร็จรับเงิน.
 *
 *   membership        → 'receipt_combined'  (ALWAYS a §86/4 tax receipt)
 *   event + TIN       → 'receipt_combined'
 *   event + no TIN    → 'receipt_separate'  (§105 ใบเสร็จรับเงิน)
 *
 * Used by `record-payment.ts` and the async `render-receipt-pdf.ts` worker so
 * the payment-time render can never mis-label a membership receipt as §105 —
 * replacing the retired `receiptNumberingMode='combined'` setting check (F.5).
 */
export function inferReceiptKind(
  subject: InvoiceSubject,
  taxId: string | null | undefined,
): ReceiptDocumentKind {
  return subject === 'event' && !buyerHasTin(taxId)
    ? 'receipt_separate'
    : 'receipt_combined';
}
