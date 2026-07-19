/**
 * T054 — InvoicingBridgePort (F5 → F4 boundary).
 *
 * F5 Application MUST NOT directly import F4 Application internals in
 * unit tests (makes mocking clumsy); instead we wrap F4's two barrel
 * exports (`getInvoiceForPayment`, `markPaidFromProcessor`) behind a
 * port, and the composition root (`makeInitiatePaymentDeps`) wires the
 * real F4 barrel calls. Principle III stays clean: F5 Application
 * talks to an interface; F5 Infrastructure provides the wire-up to F4.
 */
import type { Result } from '@/lib/result';
import type {
  InvoiceStatus,
  F4InvoicePaidEvent,
  TaxAtPaymentFlag,
} from '@/modules/invoicing';
import type { Satang } from '@/lib/money';

export interface InvoiceForPaymentDTO {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly totalSatang: Satang;
  readonly memberId: string;
  readonly tenantId: string;
}

export type GetInvoiceForPaymentBridgeError =
  | { readonly code: 'not_found' }
  | { readonly code: 'forbidden' }
  | { readonly code: 'not_payable'; readonly status: InvoiceStatus }
  /**
   * F5R3v3 H-1 (2026-05-16) — bridge detected an unbrandable F4 money
   * field (e.g. negative `totalSatang` from data corruption, dropped
   * CHECK constraint, or out-of-band manual SQL). The pre-fix path
   * silently capped at `asSatang(0n)` and let the use-case fabricate a
   * `createPaymentIntent({ amount: 0n })` call — Stripe would reject
   * with `amount_too_small` and surface as a retry-storm `processor_
   * unavailable`, with a `payment_initiated` audit row containing the
   * wrong amount. Instead surface a discrete error so the use-case can
   * emit a `payment_invoice_data_corrupt` audit + return a typed 422.
   */
  | { readonly code: 'corrupted_total'; readonly invoiceId: string }
  /**
   * REMOVE-WITH-064-REMEDIATION (online-payment site — master checklist
   * at the guard in record-payment.ts) — F4's payability read rejected a
   * LEGACY issued no-TIN EVENT invoice (S0 money trap: Stripe would
   * capture money the webhook-side `recordPayment` guard then refuses to
   * apply, with no auto-refund). Carried VERBATIM (not collapsed into
   * `not_payable`) so initiate-payment's warn log + the route's
   * `useCaseErrorCode` keep the remediation-runbook pointer.
   */
  | { readonly code: 'legacy_no_tin_event_not_payable' }
  /**
   * 088 SEC-MED — F4's payability read rejected a NEW-FLOW bill (issued while
   * FEATURE_088_TAX_AT_PAYMENT was ON) being paid after the flag rolled back
   * to OFF. Creating a PI would let Stripe capture money the webhook-side
   * `recordPayment` guard then refuses to apply (same code, permanent, NO
   * auto-refund) — S0 stranded funds. Carried VERBATIM (not collapsed into
   * `not_payable`) so initiate-payment's warn log + the route's
   * `useCaseErrorCode` keep the flag-rollback discriminator for ops.
   */
  | { readonly code: 'new_flow_bill_requires_flag_on' };

export interface MarkPaidFromProcessorInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly requestId: string | null;
  readonly actorUserId: string;
  readonly method: 'stripe_card' | 'stripe_promptpay';
  readonly paymentIntentId: string;
  readonly chargeId: string | null;
  /** YYYY-MM-DD Asia/Bangkok settlement date. */
  readonly settlementDate: string;
  /**
   * T128a (2026-04-27 verify-driven): when `true`, F4 skips the auto-
   * email outbox enqueue for the receipt PDF. Other side-effects
   * (status flip, audit, PDF render+upload, registration-fee flip)
   * still run. Set by F5 `confirmPayment` from the tenant's
   * `tenant_payment_settings.auto_email_on_payment` column.
   * `undefined` keeps default-on (current MVP behaviour) so this is a
   * pure widening change — no F4-internal call site is affected.
   */
  readonly suppressReceiptEmail?: boolean;
  /**
   * F8 cross-module on-paid hooks forwarded verbatim to F4's
   * `markPaidFromProcessor` → `recordPayment`. Each callback fires
   * inside F4's atomic tx; rejection rolls back the entire webhook
   * tx including the F4 invoice flip. Wired at the F5 webhook
   * composition root (`makeProcessWebhookEventDeps`/`makeConfirmPaymentDeps`)
   * via `f8OnPaidCallbacks(tenantId)` when `FEATURE_F8_RENEWALS=true`.
   * Without this, Stripe-paid renewal invoices flip to `paid` while
   * the F8 RenewalCycle stays stuck in `awaiting_payment`.
   */
  readonly onPaidCallbacks?: ReadonlyArray<
    (evt: F4InvoicePaidEvent, tx?: unknown) => Promise<void>
  >;
}

export interface InvoicingBridgePort {
  getInvoiceForPayment(input: {
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly actor?: {
      readonly userId: string;
      readonly role: 'admin' | 'manager' | 'member';
      readonly requestId: string | null;
      readonly memberId?: string;
    };
    /**
     * 088 SEC-MED — FEATURE_088_TAX_AT_PAYMENT (2-state flow flag), forwarded
     * verbatim into F4's payability read. Wired from `env.features.f088TaxAtPayment`
     * at `makeInitiatePaymentDeps` (initiate) / `makeConfirmPaymentDeps` +
     * `makeProcessWebhookEventDeps` (webhook confirm).
     */
    readonly taxAtPayment: TaxAtPaymentFlag;
    /**
     * 088 SEC-MED — the orthogonal reconciliation axis. `false` on the INITIATE
     * (self-pay) read → F4's new-flow-bill flag-rollback guard is armed (refuse a
     * capture the webhook-side guard would then reject). `true` on the webhook
     * confirm read → the guard stays DORMANT (money already captured; the
     * write-side record-payment guard still enforces the flag). Forwarded verbatim.
     */
    readonly reconciliationPath: boolean;
    /**
     * F-1 item 4 / Variant B (money-remediation Task 7) — thread the caller's
     * tx so the F4 payability read runs on the SAME pooled connection instead
     * of `makeGetInvoiceDeps` opening a second `runInTenant`.
     *
     * `confirm-payment` calls this from inside its Phase-A `withTx` while
     * holding `FOR UPDATE` on the payment row, so the un-threaded form
     * acquires a second pooled connection while the first is still held — the
     * self-deadlock shape `getInvoiceCreditedTotal` (B.1 Fix#2) and
     * `getInvoiceStatus` already fixed. This closes the last of the three.
     *
     * The connection already carries `SET LOCAL app.current_tenant`, so the
     * read stays tenant-scoped. Omit it for standalone reads (the self-pay
     * `initiate-payment` path is not inside a tx and passes nothing).
     */
    readonly externalTx?: unknown;
  }): Promise<Result<InvoiceForPaymentDTO, GetInvoiceForPaymentBridgeError>>;

  /**
   * Passthrough to F4's `markPaidFromProcessor`. Returns F4 errors
   * summarised into a `{ code: string; detail: string }` shape via
   * `summariseF4Error` (whitelisted scalar fields only — audit
   * 2026-04-25 finding #16, no PII leak). F5 callers surface as a
   * single `f4_bridge_error` code since each F4 failure is operational
   * (logger + audit) rather than user-facing.
   *
   * M-4 (review 2026-04-27): clarified comment — earlier docstring
   * claimed "raw F4 error shape as an opaque `unknown` error" which
   * is false (the type signature shows `{code, detail}` already).
   *
   * Reliability D-03 (Group E1, 2026-04-24): accepts an optional `tx`
   * param so the adapter can share the Drizzle connection/transaction
   * with F4's `markPaidFromProcessor` — confirm-payment wires the tx
   * from inside its `withTx` callback so the payment row update and
   * the invoice-status flip to `paid` commit atomically. Without this,
   * an F4 failure after our tx commit leaves the invoice in `issued`
   * while the payment row says `succeeded` (SC-013 invariant violation).
   */
  markPaidFromProcessor(
    input: MarkPaidFromProcessorInput,
    tx?: unknown,
  ): Promise<Result<void, { readonly code: string; readonly detail: string }>>;

  /**
   * Issue a credit note tied to an F5 refund (Phase 6 / T108).
   *
   * Wraps F4's `issueCreditNoteFromRefund` use-case. F4 owns the CN
   * row, sequence allocation, PDF render+upload, audit emission,
   * outbox enqueue, and the invoice status transition (→ `credited`
   * or `partially_credited`). F5 supplies the refund context.
   *
   * Returns the F4 credit-note id + invoice status post-transition
   * so the F5 use-case can include them in the `issueRefund` success
   * envelope (admin UI shows the new CN number immediately).
   *
   * Errors are summarised to the same `{ code, detail }` shape as
   * `markPaidFromProcessor` — F5 callers branch on a single
   * `f4_bridge_error` code; F4-domain detail lands in audit + log.
   */
  issueCreditNoteFromRefund(input: {
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly refundId: string;
    readonly amountSatang: Satang;
    readonly reason: string;
    readonly actorUserId: string;
    readonly requestId: string | null;
  }): Promise<
    Result<
      {
        readonly creditNoteId: string;
        readonly creditNoteNumber: string;
      },
      { readonly code: string; readonly detail: string }
    >
  >;

  /**
   * B.1 (#4) — read the invoice's F4-authoritative credited + total amounts
   * so the F5 refund pre-flight (`issueRefund` Phase A) can cap the
   * refundable at the invoice's UN-credited headroom (`total − credited`)
   * IN ADDITION to the payment-based cap (`payment.amount − Σ F5 succeeded
   * refunds`). The effective remaining is `min(payment-based, invoice-credit-
   * based)`.
   *
   * Without this cap a refund that clears the payment-based limit but exceeds
   * `invoice.total − invoice.creditedTotal` (e.g. a manual F4 credit note was
   * already issued against the invoice) would move money at Stripe that F4
   * then REFUSES as an over-credit credit note → an orphaned Stripe refund
   * with no CN (bug #4). The caller REJECTS such a refund BEFORE any
   * `createRefund` call.
   *
   * Tenant-scoped read: the adapter wraps F4's `getInvoice` via
   * `makeGetInvoiceDeps(tenantId)`, whose repo runs inside `runInTenant`
   * (Principle I — never the pool-global `db`). No actor is threaded — this
   * is an internal reconciliation read (like the webhook payability path), so
   * it emits no cross-tenant-probe audit.
   *
   * Returns the two branded amounts on success. `not_found` = the invoice
   * could not be resolved in the actor tenant (a data-integrity anomaly — a
   * refundable payment always FK-references a live invoice). `invalid_total`
   * = the F4 money field failed `asSatang` (null `total` on a draft, or a
   * negative value from a dropped CHECK / manual SQL). `read_failed` (B.1
   * review Minor#1) = the underlying F4 read THREW (e.g. Neon down / tx
   * aborted / tenant-context mismatch) — the adapter catches it so the caller
   * gets a graceful `Result.err` (→ 502) instead of an unhandled 500. On ANY
   * error the caller refuses the refund rather than proceeding blind to Stripe.
   *
   * B.1 review Fix#2 — optional `externalTx`: when the caller is already
   * inside a `runInTenant`-based tx (the F5 refund Phase A holds the payment
   * `FOR UPDATE` on it), it threads that tx here so the F4 read runs on the
   * SAME pooled connection instead of the adapter opening a 2nd `runInTenant`
   * (a nested pooled-connection acquisition that can self-deadlock under
   * concurrent refunds). The connection already carries `SET LOCAL
   * app.current_tenant`, so the read stays tenant-scoped. Omit it for standalone
   * reads (the adapter opens its own tenant-bound tx, unchanged behaviour).
   */
  getInvoiceCreditedTotal(input: {
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly externalTx?: unknown;
  }): Promise<
    Result<
      {
        readonly creditedTotalSatang: Satang;
        readonly totalSatang: Satang;
        /**
         * F-4 (money-remediation Task 7) — the invoice's F4-authoritative
         * status, so the refund pre-flight can mirror F4's credit-note STATUS
         * gate (`issue-credit-note.ts:419`) instead of only its amount gate.
         *
         * The caller MUST admit exactly `paid` and `partially_credited`. A
         * `=== 'paid'` shortcut looks equivalent and is not: after the first
         * partial refund F4 flips the invoice to `partially_credited`, so the
         * shortcut breaks every SECOND partial refund — a live regression
         * worse than the bug this field exists to fix.
         */
        readonly status: InvoiceStatus;
        /**
         * F-4 — mirrors F4's §105 gate (`issue-credit-note.ts:476`,
         * `receipt_not_creditable`). `false` when the invoice is an EVENT
         * invoice issued to a non-VAT-registrant buyer: that buyer received a
         * §105 ใบเสร็จรับเงิน, never a TIN-bearing §86/4 tax invoice, so they
         * have no input VAT to reverse and a §86/10 ใบลดหนี้ against it is
         * legally void. This is PERMANENT — no retry ever clears it.
         *
         * Derived by the adapter via the SAME shared discriminator F4 uses
         * (`inferEventDocumentKind` ∘ `resolveBuyerIsVatRegistrant`), so
         * issue-time, credit-time and this pre-flight cannot drift apart.
         */
        readonly creditable: boolean;
        /**
         * F-4 — mirrors F4's materialised-receipt gate
         * (`issue-credit-note.ts:491`, `receipt_not_rendered`): a §86/10
         * ใบลดหนี้ can only adjust a receipt that actually exists as bytes.
         * `true` iff `receiptPdfStatus === 'rendered'`.
         *
         * Unlike the other two axes this one is TRANSIENT — the async receipt
         * worker may still be `pending`, in which case the refund becomes
         * possible once it renders.
         */
        readonly receiptRendered: boolean;
      },
      { readonly code: 'not_found' | 'invalid_total' | 'read_failed' }
    >
  >;

  /**
   * B.2 (tax#5) — read the invoice's F4-AUTHORITATIVE status AFTER the refund's
   * credit note has been issued, so the shared `finalizeSucceededRefund` helper
   * reports the tax-document system's own recorded status instead of a
   * projection of the F5 payment status.
   *
   * Why this matters: the F5 payment status only knows about F5 refunds. When
   * an invoice already carries a MANUAL F4 credit note that — together with the
   * F5 refund's credit note — FULLY credits it, the payment may still read
   * `partially_refunded` (the F5 refunds alone don't cover the whole payment)
   * while F4 has flipped the invoice to `credited`. The old
   * `refunded → 'credited', else 'partially_credited'` projection reported the
   * wrong status in that case. This read echoes F4's decision (F4 owns the
   * credited/partially_credited boundary in `issueCreditNote`), so all three
   * finaliser callers (admin, webhook, sweep) report identically.
   *
   * Post-CN the invoice is ALWAYS `credited` or `partially_credited` (F4's
   * `applyCreditNoteRollup` set exactly one of those); the adapter narrows to
   * `CreditedInvoiceStatus` and returns `unexpected_status` for anything else
   * (data anomaly) so the caller can fall back to its payment-derived
   * projection rather than surface a wrong status. `not_found` = the invoice
   * could not be resolved in the actor tenant. `read_failed` = the underlying
   * F4 read THREW (Neon down / tx aborted). On ANY error the caller falls back
   * to the payment-derived projection — a refund that already succeeded (CN +
   * Stripe both committed) is NEVER failed just because this status READ hiccuped.
   *
   * Tenant-scoped read: wraps F4's `getInvoice` via `makeGetInvoiceDeps`, whose
   * repo runs inside `runInTenant` (Principle I — never the pool-global `db`).
   * No actor is threaded — internal reconciliation read, so no cross-tenant
   * probe audit.
   *
   * `externalTx` (B.1 lesson): when the caller is already inside a
   * `runInTenant`-based tx (the finaliser holds the refund/payment rows on it),
   * it threads that tx here so the F4 read runs on the SAME pooled connection
   * instead of opening a 2nd nested `runInTenant` (a nested pooled-connection
   * acquisition that can self-deadlock while holding row locks). The finalise
   * tx is READ COMMITTED, so the read sees F4's just-committed CN status flip
   * (F4 owns its own tx; it commits before this read runs). Omit `externalTx`
   * for standalone reads (the adapter opens its own tenant-bound tx).
   */
  getInvoiceStatus(input: {
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly externalTx?: unknown;
  }): Promise<
    Result<
      CreditedInvoiceStatus,
      { readonly code: 'not_found' | 'unexpected_status' | 'read_failed' }
    >
  >;
}

/**
 * Post-CN invoice status. F5 reads this F4-authoritative value via
 * `getInvoiceStatus` (tx-threaded, see that method's docstring) AFTER the
 * credit note is issued — F4 owns the `credited`/`partially_credited`
 * boundary, including cases where a pre-existing MANUAL F4 credit note
 * already partially credited the invoice (tax#5). The refund-arithmetic
 * projection (`refundedAmountSatang === payment.amountSatang` → `'credited'`)
 * is used ONLY as a fallback when the `getInvoiceStatus` read errors, so an
 * already-succeeded refund is never failed over a status-read hiccup. Do NOT
 * remove `getInvoiceStatus` in favour of the arithmetic projection alone —
 * that reintroduces tax#5.
 */
export type CreditedInvoiceStatus = 'partially_credited' | 'credited';
