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
import type { Refund, RefundStatus } from '../../domain/refund';
import type { Satang } from '@/lib/money';
export type { RefundStatus };

export interface RefundRow {
  readonly id: string;
  readonly tenantId: string;
  readonly paymentId: PaymentId;
  readonly invoiceId: string;
  readonly amountSatang: Satang;
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
      readonly amountSatang: Satang;
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
       * Optional optimistic-concurrency guard (S5 / RR-1). When set, the
       * UPDATE additionally filters `WHERE status = expectedCurrentStatus`.
       * Zero rows matched → repo returns `null` (NOT throw) so the caller
       * can distinguish a lost race from a genuine error. When omitted,
       * the adapter throws on zero-match (preserves throw-on-zero
       * semantics for callers that re-check under their own lock).
       *
       * Used by `sweepStalePendingRefunds` to ensure the sweep does
       * not flip a row that has been concurrently finalised to
       * `succeeded`/`failed` by a different writer (e.g. the webhook
       * `charge.refunded` branch or issueRefund's Phase B).
       *
       * CONTRACT (mirrors `payments-repo.updateStatus` H-4): every
       * caller passing `expectedCurrentStatus` MUST handle the `null`
       * return branch. The sweep re-throws a sentinel on `null` so its
       * per-row tx rolls back and no `stale_pending_refund_detected`
       * audit commits.
       */
      readonly expectedCurrentStatus?: RefundStatus;
    },
  ): Promise<RefundRow | null>;

  /** Look up an existing refund by Stripe refund id (dedupe webhook re-delivery). */
  findByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<RefundRow | null>;

  /**
   * A.6 — narrow write: set ONLY `processor_refund_id`, leaving
   * `status` and `completed_at` untouched (a refund row is inserted
   * `status='pending'` before Stripe assigns a refund id; this method
   * durably records that id as soon as the processor accepts the
   * request, ahead of the eventual succeeded/failed outcome).
   *
   * CHECK-safe by design: `refunds_succeeded_iff_complete` is the
   * biconditional `(status='succeeded') = (processor_refund_id IS NOT
   * NULL AND credit_note_id IS NOT NULL)`. With `status` still
   * `'pending'` the LHS is `false`; `credit_note_id` remains NULL so
   * the RHS is also `false` — `false = false` satisfies the
   * constraint regardless of `processor_refund_id`.
   *
   * Throws on zero-match — `refundId` is expected to already exist
   * (the row is inserted via `insert` before this is ever called).
   */
  attachProcessorRefundId(
    tx: unknown,
    input: {
      readonly refundId: string;
      readonly tenantId: string;
      readonly processorRefundId: string;
    },
  ): Promise<void>;

  /**
   * A.6 — `SELECT … WHERE tenant_id = ? AND processor_refund_id = ?
   * FOR UPDATE`. Serialises concurrent writers reconciling the same
   * Stripe refund (e.g. a `refund.updated` webhook racing the
   * stale-pending sweep or `issueRefund` Phase B).
   *
   * Returns the full Domain `Refund` aggregate (NOT the port's slim
   * `RefundRow`) — the webhook reconcile use-case needs every
   * state-machine-relevant field (`reason`, `failureReasonCode`,
   * `creditNoteId`, timestamps) to decide the next transition, not
   * just the aggregate-context subset `RefundRow` carries.
   */
  lockForUpdateByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<Refund | null>;

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
    readonly succeededSumSatang: Satang;
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
   *
   * A.14 — `processorRefundId` (the Stripe `re_…` id, nullable) is
   * surfaced so the Stripe-aware sweep can `retrieveRefund` the real
   * outcome and finalise the row instead of blind-failing it. It is
   * NULL only in the rare window where `issueRefund` inserted the
   * pending row + Stripe accepted the refund but the `attachProcessorRefundId`
   * tx crashed before persisting the id — those rows cannot be
   * reconciled against Stripe and are skipped by the sweep (never
   * blind-failed — a real refund may exist).
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
      readonly amountSatang: Satang;
      readonly initiatedAt: Date;
      readonly correlationId: string;
      readonly initiatorUserId: string;
      readonly processorRefundId: string | null;
    }>
  >;
}
