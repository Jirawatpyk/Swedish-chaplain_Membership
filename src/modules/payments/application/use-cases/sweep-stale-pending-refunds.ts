/**
 * T130a — sweepStalePendingRefunds use-case (F5 Phase 9 polish).
 *
 * Recovery sweep for the Postgres double-fault scenario in
 * `issueRefund`'s two-phase tx model:
 *
 *   - Phase A commits the `pending` refund row + audit `refund_initiated`
 *   - External: Stripe createRefund + F4 issueCreditNoteFromRefund
 *   - Phase B finalises the row to `succeeded` + flips Payment.status
 *   - Phase B `catch` flips the row to `failed` if Phase B's tx fails
 *
 * The double-fault: Phase B's tx fails AND the catch's failure-finalise
 * tx also fails (Postgres outage spanning both attempts). The pending
 * refund row stays forever, and the `refund_in_progress` guard at
 * `issueRefund` step 3 then permanently blocks all future refunds on
 * that payment until ops manually flip the row.
 *
 * This sweep runs hourly (or on-demand via the cron route at
 * `/api/internal/sweep-stale-pending-refunds`) and:
 *
 *   1. Finds pending refunds older than `olderThanHours` (default 24).
 *   2. For each row: flip status='failed' with
 *      `failureReasonCode='stale_pending_sweep'` + emit
 *      `stale_pending_refund_detected` audit (10y retention — F4
 *      tax-doc lineage) with payload `{refund_id, payment_id,
 *      invoice_id, age_minutes, runbook_url}`.
 *   3. Returns counts so the route handler can log + emit a metric.
 *
 * **Important**: Stripe + F4 may have already succeeded on these
 * rows (the catch ran AFTER both external calls returned ok). Ops
 * cross-checks via the runbook; this sweep only restores the F5
 * row's terminal state so the local refund-in-progress guard
 * unblocks. The runbook procedure issues a manual credit note +
 * payment-status flip if needed.
 *
 * Pure Application — no framework imports.
 */
import { ok, err, type Result } from '@/lib/result';
import type { AuditPort, ClockPort, RefundsRepo } from '../ports';
import { retentionFor } from '../ports/audit-port';

const STALE_PENDING_RUNBOOK_URL = 'docs/runbooks/stale-pending-refund-sweep.md';
const SWEEP_ACTOR_USER_ID = 'system:stale-pending-refund-sweep';

export interface SweepStalePendingRefundsInput {
  readonly tenantId: string;
  readonly olderThanHours?: number; // default 24
  readonly requestId: string | null;
}

export interface SweepStalePendingRefundsOutput {
  readonly sweptCount: number;
  readonly skippedCount: number;
  readonly cutoff: string; // ISO
}

export type SweepStalePendingRefundsError = {
  readonly code: 'sweep_failed';
  readonly cause: string;
};

export interface SweepStalePendingRefundsDeps {
  readonly refundsRepo: RefundsRepo;
  readonly paymentsRepo: { readonly withTx: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T> };
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export async function sweepStalePendingRefunds(
  deps: SweepStalePendingRefundsDeps,
  input: SweepStalePendingRefundsInput,
): Promise<Result<SweepStalePendingRefundsOutput, SweepStalePendingRefundsError>> {
  const olderThanHours = input.olderThanHours ?? 24;
  if (olderThanHours <= 0) {
    return err({ code: 'sweep_failed', cause: 'olderThanHours must be > 0' });
  }
  const nowMs = deps.clock.nowMs();
  const cutoffMs = nowMs - olderThanHours * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);

  let sweptCount = 0;
  let skippedCount = 0;

  try {
    await deps.paymentsRepo.withTx(async (tx) => {
      const stale = await deps.refundsRepo.listPendingOlderThan(
        tx,
        input.tenantId,
        cutoff,
      );
      for (const row of stale) {
        try {
          const failedAt = new Date(deps.clock.nowMs());
          await deps.refundsRepo.updateStatus(tx, {
            refundId: row.id,
            tenantId: input.tenantId,
            nextStatus: 'failed',
            failureReasonCode: 'stale_pending_sweep',
            completedAt: failedAt,
          });
          const ageMinutes = Math.floor(
            (failedAt.getTime() - row.initiatedAt.getTime()) / 60_000,
          );
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'stale_pending_refund_detected',
            // SECURITY: synthetic system actor — the sweep is
            // unattended; this row should never be attributed to a
            // human admin even though the original refund had one.
            actorUserId: SWEEP_ACTOR_USER_ID,
            summary: `Swept stale pending refund ${row.id} (age ${ageMinutes}min) — Postgres double-fault recovery; ops follow up via runbook`,
            payload: {
              refund_id: row.id,
              payment_id: row.paymentId,
              invoice_id: row.invoiceId,
              amount_satang: row.amountSatang.toString(),
              age_minutes: ageMinutes,
              original_initiator_user_id: row.initiatorUserId,
              original_correlation_id: row.correlationId,
              runbook_url: STALE_PENDING_RUNBOOK_URL,
            },
            retentionYears: retentionFor('stale_pending_refund_detected'),
          });
          sweptCount += 1;
        } catch {
          // Per-row error — skip + continue. The next sweep run
          // picks up the row again. Don't let one bad row block
          // the whole sweep batch.
          skippedCount += 1;
        }
      }
    });
  } catch (cause) {
    return err({
      code: 'sweep_failed',
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  return ok({
    sweptCount,
    skippedCount,
    cutoff: cutoff.toISOString(),
  });
}
