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
import type { InvoiceStatus } from '@/modules/invoicing';

export interface InvoiceForPaymentDTO {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly totalSatang: bigint;
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
   * Passthrough to F4's `markPaidFromProcessor`. Returns the raw F4
   * error shape (`RecordPaymentError`) as an opaque `unknown` error —
   * F5 callers surface as a single `f4_bridge_error` code since each
   * F4 failure is operational (logger + audit) rather than user-facing.
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
}
