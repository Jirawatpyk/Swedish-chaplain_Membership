/**
 * #729 — the orphan PDF sweep's lock-free batch read: of the documents a page
 * of keys names, which Blob keys do their rows reference?
 *
 * A committed row's keys never change after commit (issue, payment, the
 * receipt render and the credit-note issue each write theirs once, in the
 * transaction that uploaded it), so a key this read returns can be kept
 * without a row lock. A key it does not return is only a candidate: the sweep
 * re-checks an invoice or receipt key under the invoice row lock before
 * deleting it. `credit_notes` is read directly, with no join, so a missing
 * joined row can never read as "no reference".
 */
export interface OrphanPdfReferenceRepo {
  referencedKeys(
    tenantId: string,
    ids: { readonly invoiceIds: readonly string[]; readonly creditNoteIds: readonly string[] },
  ): Promise<ReadonlySet<string>>;
}
