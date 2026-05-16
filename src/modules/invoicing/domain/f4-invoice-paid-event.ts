import type { Satang } from '@/lib/money';

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
/**
 * F5 processor rails ('stripe_card', 'stripe_promptpay') + F4 native enum
 * ('bank_transfer', 'cheque', 'cash', 'other'). The F5 webhook wrapper
 * supplies the processor-rail string here even though the F4 invoice row
 * persists `'other'` (F4's enum doesn't include Stripe rails — see
 * `markPaidFromProcessor` line 148-155). Callback consumers therefore
 * see the SEMANTIC method (stripe_card vs bank_transfer) regardless of
 * how it serialises into `invoices.payment_method`.
 */
export type F4InvoicePaidPaymentMethod =
  | 'stripe_card'
  | 'stripe_promptpay'
  | 'bank_transfer'
  | 'cheque'
  | 'cash'
  | 'other';

/**
 * Origin of the mark-paid action. F8 listeners (and future cross-module
 * consumers) MAY apply different post-processing per trigger — e.g. send
 * a "thanks for paying online" email only on `'webhook'`, or emit a
 * different audit summary for `'admin_offline_mark'`.
 *
 *   - `'webhook'`            — F5 Stripe webhook (`markPaidFromProcessor`)
 *   - `'admin_manual'`       — F4 admin "Record payment" UI (default)
 *   - `'admin_offline_mark'` — F8 admin "Mark paid offline" use-case (Phase 3+)
 */
export type F4InvoicePaidTrigger =
  | 'webhook'
  | 'admin_manual'
  | 'admin_offline_mark';

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
  readonly amountSatang: Satang;
  /**
   * VAT portion, in satang. From `Invoice.vat.satang`. Useful to
   * downstream listeners that need to split net vs VAT for accounting
   * exports (e.g. F8 renewal-cycle bookkeeping). Net = `amountSatang -
   * vatSatang`.
   */
  readonly vatSatang: Satang;
  /**
   * Currency code. F4 is THB-only today (literal type on `Invoice.currency`);
   * listeners must still pattern-match on this field so future widening
   * (e.g. SEK / EUR) lands as a typed compile error rather than silent
   * misclassification.
   */
  readonly currency: 'THB';
  /**
   * Semantic payment method. For Stripe rails this carries the original
   * processor identity (`stripe_card` / `stripe_promptpay`) even though
   * the F4 invoice row persists `'other'` — F4's `payment_method` enum
   * is narrower than F5's rail set (see `markPaidFromProcessor`).
   */
  readonly paymentMethod: F4InvoicePaidPaymentMethod;
  /**
   * Origin of the mark-paid action. See `F4InvoicePaidTrigger` for
   * semantics. Defaults to `'admin_manual'` when callers don't set it
   * (preserves backward-compat for existing F4 admin paths).
   */
  readonly triggeredBy: F4InvoicePaidTrigger;
}
