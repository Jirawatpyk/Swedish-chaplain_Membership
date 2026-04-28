/**
 * T054 — RefundsRepo port (F5 Application).
 *
 * Minimal surface needed by Group D use-cases (initiate / confirm / fail /
 * cancel paths do NOT touch refunds — Group E / F ship the full refund
 * use-case). The methods below exist to support the webhook-side
 * `charge.refunded` branch + future refund use-case.
 */
import type { PaymentId } from '../../domain/payment';
// Single source of truth — Domain owns the status enum so a future
// `'voided'` addition (post-MVP) cannot drift between Domain + Port.
import type { RefundStatus } from '../../domain/refund';
export type { RefundStatus };

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
      /**
       * Optional optimistic-concurrency guard (S5). When set, the
       * UPDATE additionally filters `WHERE status = expectedCurrentStatus`.
       * Zero rows matched → repo throws → caller's tx rolls back.
       *
       * Used by `sweepStalePendingRefunds` to ensure the sweep does
       * not flip a row that has been concurrently finalised to
       * `succeeded` by a different writer (e.g. a future webhook
       * `charge.refunded` branch wired to the real adapter — the
       * F5 webhook gap noted in `infrastructure/di.ts`).
       */
      readonly expectedCurrentStatus?: RefundStatus;
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
   * separate roundtrips.
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

  /**
   * T130a — list refunds in `pending` status older than the cutoff.
   * Used by the stale-pending-refund sweep cron to flip orphaned
   * pending rows to `failed` so they don't permanently block future
   * refunds on the same payment via the `refund_in_progress` guard.
   *
   * Tenant-scoped; reads run under `runInTenant` so RLS+FORCE
   * filters cross-tenant rows. The cron's caller iterates active
   * tenants and calls this once per tenant.
   *
   * Returns the minimum fields the sweep + audit emit need; the row
   * is updated in a separate `updateStatus` call inside the same
   * tx as the audit emit for atomicity.
   */
  listPendingOlderThan(
    tx: unknown,
    tenantId: string,
    cutoff: Date,
  ): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly invoiceId: string;
      readonly amountSatang: bigint;
      readonly initiatedAt: Date;
      readonly correlationId: string;
      readonly initiatorUserId: string;
    }>
  >;
}
