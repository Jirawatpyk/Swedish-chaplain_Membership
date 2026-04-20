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
export class InvoiceApplyConflictError extends Error {
  readonly kind: 'applyIssue' | 'applyPayment' | 'applyDraftUpdate' | 'applyCreditNoteRollup';
  constructor(kind: 'applyIssue' | 'applyPayment' | 'applyDraftUpdate' | 'applyCreditNoteRollup') {
    super(`${kind}: no row updated (concurrent state change)`);
    this.name = 'InvoiceApplyConflictError';
    this.kind = kind;
  }
}
