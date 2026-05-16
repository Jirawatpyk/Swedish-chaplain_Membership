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
import type { InvoiceStatus, F4InvoicePaidEvent } from '@/modules/invoicing';
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
  | { readonly code: 'not_payable'; readonly status: InvoiceStatus };

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
}

/**
 * Post-CN invoice status. The F5 caller derives this from the refund
 * arithmetic (`refundedAmountSatang === payment.amountSatang` →
 * `'credited'` else `'partially_credited'`) — `payment.amountSatang`
 * equals `invoice.totalSatang` under F5's "one PaymentIntent covers
 * the whole invoice" invariant, so re-reading the invoice for the
 * status would be a redundant DB roundtrip.
 */
export type CreditedInvoiceStatus = 'partially_credited' | 'credited';
