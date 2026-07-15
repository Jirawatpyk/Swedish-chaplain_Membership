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
 * ever computed the buyer's status differently, a non-registrant event buyer
 * could be issued a §105 ใบเสร็จรับเงิน yet later credited via a §86/10 ใบลดหนี้
 * (legally void), or a combined tax-invoice/receipt label could be applied to
 * a buyer who must never receive one.
 *
 * 059 / PR-A Task 6a — THE DOCUMENT CLASS IS NO LONGER KEYED ON `buyerHasTin`.
 *
 * It used to be: `event + !buyerHasTin(taxId) → receipt_separate`. That asks "is
 * this text field non-blank" — and `members.tax_id` now legitimately holds a
 * PASSPORT / work-permit number for a foreign natural person, who has no Thai
 * TIN. Under the old key, such a member typing their passport number silently
 * upgraded their own §105 receipt into a §86/4 tax invoice: a legal
 * document-class change triggered by the emptiness of a text field.
 *
 * The document class follows the BUYER'S STATUS — `buyer_is_vat_registrant`,
 * pinned on the identity snapshot at issue from the RECORDED
 * `members.is_vat_registered` column (migration 0250). Callers derive that
 * boolean through the ONE shared resolver below, never by hand.
 *
 * `buyerHasTin` SURVIVES and is still exported: it remains the right predicate
 * for "do we have a number to PRINT", and it is the registrant proxy on the
 * WALK-IN path — see `resolveBuyerIsVatRegistrant`.
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
 *
 * NOTE (059 / PR-A Task 6a): this answers "is there a number to PRINT", NOT "is
 * this buyer a VAT registrant". The two questions were conflated until `tax_id`
 * began accepting a foreign passport / work-permit number. Do NOT reach for this
 * to decide a document CLASS or a §86/4 particular — `resolveBuyerIsVatRegistrant`
 * is that question's answer.
 */
export function buyerHasTin(taxId: string | null | undefined): boolean {
  return (taxId ?? '').trim() !== '';
}

/**
 * The two fields of a buyer identity snapshot the registrant resolver reads.
 * Structurally satisfied by `MemberIdentitySnapshot` (Domain VO) — declared
 * structurally so this helper carries no import of the heavier VO.
 */
export interface BuyerRegistrantParts {
  readonly tax_id: string | null;
  readonly buyer_is_vat_registrant?: boolean;
}

/**
 * 059 / PR-A Task 6a — THE single source of "is this buyer a VAT registrant?".
 *
 * Every document-class gate (issue / pay / credit) derives its boolean here, so
 * the two buyer shapes resolve identically everywhere and cannot drift — the
 * same lockstep discipline that created this module.
 *
 * There are exactly TWO buyer shapes on an invoice, discriminated by `memberId`:
 *
 *   MATCHED MEMBER (memberId non-null) — membership invoices, and event invoices
 *     whose attendee matched an F3 member. Their snapshot is pinned at ISSUE by
 *     `memberIdentityAdapter.getForIssue`, which reads the RECORDED
 *     `members.is_vat_registered` column (migration 0250). Use the recorded fact.
 *     A snapshot written before that field existed omits the key and zod resolves
 *     it to `false` — FAIL-CLOSED, the correct default for a §86/4 particular
 *     (assert nothing you cannot evidence).
 *
 *   WALK-IN / NON-MEMBER (memberId null) — a one-off event buyer typed into the
 *     event-fee form. There is NO `members` row, hence NO recorded
 *     `is_vat_registered` to read: their snapshot's flag is ALWAYS the zod default
 *     `false`. Keying them on it would regress every walk-in with a real company
 *     TIN from a §86/4 tax invoice down to a §105 receipt. They therefore keep
 *     inferring from TIN-PRESENCE — behaviour UNCHANGED.
 *
 *     That inference is safe HERE AND ONLY HERE because the walk-in `buyer.tax_id`
 *     is `/^\d{13}$/`-locked at the draft boundary (`create-event-invoice-draft`
 *     zod schema + an explicit re-check), so a passport can never reach this path
 *     and "non-blank" still means "a Thai 13-digit taxpayer number". A MEMBER's
 *     `tax_id` carries no such guarantee — which is precisely why members must use
 *     the recorded flag.
 *
 *     This deliberately does NOT write `buyer_is_vat_registrant` onto the walk-in's
 *     snapshot. That field ALSO drives the §86/4 สำนักงานใหญ่ / สาขาที่ line
 *     (`buyerBranchEl` in invoice-template.tsx), and a 13-digit number is NOT
 *     evidence of VAT registration (a natural person's national ID is also 13
 *     digits). Flipping it would print a head-office particular asserted on a
 *     guess — the exact class of defect this branch exists to delete. The DECISION
 *     is computed here; the SNAPSHOT is left alone.
 *
 * A missing snapshot (a corrupt row) resolves to `false` — fail-closed.
 */
export function resolveBuyerIsVatRegistrant(
  memberId: string | null,
  buyer: BuyerRegistrantParts | null | undefined,
): boolean {
  if (!buyer) return false;
  if (memberId === null) return buyerHasTin(buyer.tax_id);
  return buyer.buyer_is_vat_registrant === true;
}

/**
 * Resolves the ISSUE-time PDF document kind from the invoice subject + the
 * buyer's VAT-REGISTRANT status (derived via `resolveBuyerIsVatRegistrant` —
 * NEVER `buyerHasTin`).
 *
 *   event + non-registrant  → 'receipt_separate'  (ใบเสร็จรับเงิน / §105 receipt)
 *   event + registrant      → 'invoice'           (ใบกำกับภาษี / §86/4 tax invoice)
 *   membership              → 'invoice'           (ALWAYS a §86/4 ใบกำกับภาษี, with
 *                                                  or without a buyer TIN — a
 *                                                  non-registrant membership buyer
 *                                                  gets a valid §86/4 with
 *                                                  name+address, TIN line absent
 *                                                  [066 relax]. The discriminator
 *                                                  never labels a membership doc a
 *                                                  §105 receipt.)
 */
export function inferEventDocumentKind(
  subject: InvoiceSubject,
  buyerIsVatRegistrant: boolean,
): EventDocumentKind {
  return subject === 'event' && !buyerIsVatRegistrant
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
 * kind from the invoice subject + the buyer's VAT-REGISTRANT status. Distinct
 * from {@link inferEventDocumentKind} (which returns the ISSUE-time kind, where a
 * membership resolves to the non-tax `'invoice'` ใบแจ้งหนี้): at payment a
 * membership / event-REGISTRANT buyer receives the combined §86/4 + §105ทวิ
 * ใบกำกับภาษี/ใบเสร็จรับเงิน, while only an event NON-REGISTRANT buyer keeps the
 * §105 `receipt_separate` ใบเสร็จรับเงิน.
 *
 *   membership              → 'receipt_combined'  (ALWAYS a §86/4 tax receipt)
 *   event + registrant      → 'receipt_combined'
 *   event + non-registrant  → 'receipt_separate'  (§105 ใบเสร็จรับเงิน)
 *
 * Used by `record-payment.ts` and the async `render-receipt-pdf.ts` worker so
 * the payment-time render can never mis-label a membership receipt as §105 —
 * replacing the retired `receiptNumberingMode='combined'` setting check (F.5).
 */
export function inferReceiptKind(
  subject: InvoiceSubject,
  buyerIsVatRegistrant: boolean,
): ReceiptDocumentKind {
  return subject === 'event' && !buyerIsVatRegistrant
    ? 'receipt_separate'
    : 'receipt_combined';
}
