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
 *   membership      → 'invoice'           (never a §105 receipt; the membership
 *                                          pre-issue gate independently requires
 *                                          a TIN, but the discriminator itself
 *                                          must never label a membership doc as
 *                                          a receipt)
 */
export function inferEventDocumentKind(
  subject: InvoiceSubject,
  taxId: string | null | undefined,
): EventDocumentKind {
  return subject === 'event' && !buyerHasTin(taxId)
    ? 'receipt_separate'
    : 'invoice';
}
