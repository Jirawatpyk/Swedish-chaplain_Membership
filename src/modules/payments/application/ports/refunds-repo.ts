/**
 * T054 — RefundsRepo port (F5 Application).
 *
 * Minimal surface needed by Group D use-cases (initiate / confirm / fail /
 * cancel paths do NOT touch refunds — Group E / F ship the full refund
 * use-case). The methods below exist to support the webhook-side
 * `charge.refunded` branch + future refund use-case.
 */
import type { PaymentId } from '../../domain/payment';

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface RefundRow {
  readonly id: string;
  readonly tenantId: string;
  readonly paymentId: PaymentId;
  readonly invoiceId: string;
  readonly amountSatang: bigint;
  readonly status: RefundStatus;
  readonly processorRefundId: string | null;
}

export interface RefundsRepo {
  insert(
    tx: unknown,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly paymentId: PaymentId;
      readonly invoiceId: string;
      readonly amountSatang: bigint;
      readonly reason: string;
      readonly status: RefundStatus;
      readonly processorRefundId: string | null;
      readonly initiatorUserId: string;
      readonly correlationId: string;
      readonly initiatedAt: Date;
    },
  ): Promise<RefundRow>;

  updateStatus(
    tx: unknown,
    input: {
      readonly refundId: string;
      readonly tenantId: string;
      readonly nextStatus: RefundStatus;
      readonly processorRefundId?: string | null;
      readonly failureReasonCode?: string | null;
      readonly creditNoteId?: string | null;
      readonly completedAt: Date;
    },
  ): Promise<RefundRow>;

  /** Look up an existing refund by Stripe refund id (dedupe webhook re-delivery). */
  findByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<RefundRow | null>;

  /** Sum of succeeded refund amounts against a payment — remaining-refundable invariant. */
  sumSucceededForPayment(tx: unknown, tenantId: string, paymentId: PaymentId): Promise<bigint>;

  /**
   * Count refunds against a payment in `pending` status. Used by
   * `issueRefund` (T108) inside the payment-row FOR UPDATE lock to
   * detect a concurrent in-flight refund and surface
   * `refund_in_progress` (409) instead of inserting a duplicate row.
   *
   * Under correct usage the lock + count happens inside the same
   * tx so the read sees the latest committed state.
   */
  countPendingForPayment(
    tx: unknown,
    tenantId: string,
    paymentId: PaymentId,
  ): Promise<number>;

  /**
   * Next attempt-sequence number for (tenant, payment). Drives the
   * Stripe idempotency key `rfnd-{paymentId}-{seq}` so repeated
   * client clicks within the lock window collapse onto the same
   * Stripe refund row (T110). Caller invokes inside the same tx as
   * the FOR UPDATE lock to avoid race.
   */
  nextRefundSeq(tx: unknown, tenantId: string, paymentId: PaymentId): Promise<number>;
}
