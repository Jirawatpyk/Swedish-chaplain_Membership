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
}
