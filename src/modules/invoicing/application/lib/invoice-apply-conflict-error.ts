/**
 * Thrown by repo `applyIssue` / `applyPayment` when the WHERE-clause
 * status guard eliminates the row (concurrent state change between
 * lockForUpdate and the UPDATE). Application use cases catch via
 * `instanceof` and map to a typed error (invoice_already_issued /
 * concurrent_state_change) — never a string-message match.
 *
 * Lives in `application/lib/` because both layers reference it:
 *   - Infrastructure repo throws it from within applyIssue/applyPayment
 *   - Application use-cases catch it via instanceof
 * Placing it under Application keeps Principle III clean (infra
 * depends on a higher-level abstraction, not the other way round).
 */
export type InvoiceApplyConflictKind =
  | 'applyIssue'
  | 'applyPayment'
  // 064 — as-paid issuance (single UPDATE draft→paid, event subject).
  // Distinct kind so a draft→paid race loser is distinguishable from a
  // plain issue or payment-flip conflict in logs/alerts.
  | 'applyIssueAsPaid'
  | 'applyDraftUpdate'
  | 'applyCreditNoteRollup'
  | 'applyVoid'
  // R2-I-NEW-1 — distinct kinds for T166 receipt-PDF write paths so
  // log/alert can tell a payment-flip conflict apart from a receipt-
  // render conflict (different runbooks, different on-call response).
  | 'applyReceiptPdf'
  | 'applyReceiptPdfFailure';

export class InvoiceApplyConflictError extends Error {
  readonly kind: InvoiceApplyConflictKind;
  constructor(kind: InvoiceApplyConflictKind) {
    super(`${kind}: no row updated (concurrent state change)`);
    this.name = 'InvoiceApplyConflictError';
    this.kind = kind;
  }
}
