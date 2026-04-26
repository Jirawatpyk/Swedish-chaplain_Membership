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

  /**
   * Combined aggregate snapshot for a (tenant, payment) tuple,
   * computed in ONE SELECT under the payment-row FOR UPDATE lock.
   * Used by `issueRefund` (T108) — replaces the previous trio of
   * `countPendingForPayment` + `sumSucceededForPayment` +
   * `nextRefundSeq` so the lock-hold window does not absorb 3
   * separate roundtrips (review 2026-04-26 simplify E3).
   *
   * Returns:
   *   - `pendingCount` — # of refunds with status='pending'.
   *     `> 0` → use-case rejects with `refund_in_progress`.
   *   - `succeededSumSatang` — Σ amount_satang WHERE status='succeeded'.
   *     Drives the FR-011b remaining-refundable invariant.
   *   - `nextSeq` — `COUNT(*) + 1` over all rows in the partition;
   *     drives the Stripe idempotency key `rfnd-{paymentId}-{seq}`
   *     so repeated client clicks within the lock window collapse
   *     onto the same Stripe refund row.
   *
   * Caller MUST invoke inside the tx that holds the
   * `SELECT … FOR UPDATE` on `payments(id)` so all three reads see
   * the same committed snapshot.
   */
  getRefundContextForUpdate(
    tx: unknown,
    tenantId: string,
    paymentId: PaymentId,
  ): Promise<{
    readonly pendingCount: number;
    readonly succeededSumSatang: bigint;
    readonly nextSeq: number;
  }>;
}
