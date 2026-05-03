/**
 * T009 (F8 Phase 2 Wave A) — F4InvoicePaidEvent
 *
 * Cross-module callback payload emitted by F4's `recordPayment` use-case
 * once an invoice transitions `issued → paid`. Other bounded contexts
 * register zero or more callback functions on `RecordPaymentDeps.onPaidCallbacks`
 * (composition root) and receive this canonical event shape inside the
 * SAME DB transaction that flipped the invoice — guaranteeing atomic
 * coordination per Constitution Principle VIII (Reliability).
 *
 * Atomic semantics:
 *   - Callbacks fire AFTER `applyPayment` (issued→paid UPDATE), AFTER the
 *     `invoice_paid` audit emit, AFTER outbox enqueue + registration-fee
 *     flip — but BEFORE `withTx` commits.
 *   - Any callback rejection propagates out of `withTx`, the entire
 *     transaction (including the F4 invoice flip) rolls back. Callers
 *     receive the original error (or a typed wrapper) instead of `paid`.
 *   - Callbacks run sequentially in registration order. The first
 *     rejection short-circuits the chain.
 *
 * Why a Domain-layer interface (and not Application):
 *   - This shape is the cross-module contract — adapters in F8/F5/etc.
 *     consume it. Living in Domain makes it framework-free + free of
 *     ORM-typed leakage (Constitution Principle III).
 *   - The fields are pure invariants of "an invoice was just paid" —
 *     they belong with the Invoice aggregate, not with infrastructure.
 *
 * Field design notes:
 *   - `amountSatang: bigint` mirrors `Money.satang` exactly — no
 *     int<->bigint conversion at the boundary. F4 invoice rows are
 *     THB-only today (`Invoice.currency: 'THB'` literal), so the
 *     `currency` field is fixed at 'THB' until F4 widens.
 *   - `paidAt: string` carries the server-side ISO 8601 UTC timestamp
 *     from `invoices.paid_at` (set by `applyPayment`). NOT the admin-
 *     entered `paymentDate` (which is a YYYY-MM-DD bookkeeping date).
 *     Listeners that need cycle-completion correlation against wall
 *     clock should use `paidAt`.
 *   - No `paymentId` field: F4 doesn't carry the F5 `payments` row id;
 *     listeners that need it can resolve via `invoiceId` against F5's
 *     own repos. Keeping the surface area minimal reduces cross-module
 *     coupling.
 *
 * F8 hookup (research.md R12 + tasks.md T054 wiring):
 *   F8's composition root registers a `complete-cycle-on-paid` callback
 *   into `makeRecordPaymentDeps`. The callback resolves the linked
 *   `renewal_cycles` row by `invoiceId` and transitions
 *   `awaiting_payment → completed` inside the same tx. Atomic by
 *   construction.
 */
export interface F4InvoicePaidEvent {
  /** Tenant the invoice belongs to (matches `app.current_tenant` RLS context). */
  readonly tenantId: string;
  /** F4 invoice id. UUID string. */
  readonly invoiceId: string;
  /** F3 member the invoice was issued to. UUID string. */
  readonly memberId: string;
  /**
   * Server-side mark-paid timestamp (ISO 8601 UTC). From
   * `invoices.paid_at` set by `applyPayment`. Distinct from
   * `payment_date` (admin-entered YYYY-MM-DD bookkeeping date).
   */
  readonly paidAt: string;
  /**
   * Total amount paid, in satang (THB × 100). Mirrors
   * `Invoice.total.satang`. Listeners doing arithmetic should keep
   * the `bigint` representation rather than coercing to `number`.
   */
  readonly amountSatang: bigint;
  /**
   * Currency code. F4 is THB-only today (literal type on `Invoice.currency`);
   * listeners must still pattern-match on this field so future widening
   * (e.g. SEK / EUR) lands as a typed compile error rather than silent
   * misclassification.
   */
  readonly currency: 'THB';
}
