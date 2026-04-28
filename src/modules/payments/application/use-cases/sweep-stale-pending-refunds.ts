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
 * This sweep runs daily (Vercel Cron Hobby `0 3 * * *` + cron-job.org
 * `0 15 * * *` redundantly — see runbook § "Redundant scheduling") or
 * on-demand at `/api/cron/sweep-stale-pending-refunds` and:
 *
 *   1. Finds pending refunds older than `olderThanHours` (default 24).
 *   2. For each row, in its OWN transaction (W1 fix — Postgres tx-abort
 *      semantics make a single shared tx degenerate after the first
 *      per-row error): emit `stale_pending_refund_detected` audit FIRST
 *      (W2 fix — audit-before-mutation guarantees no orphan failed row
 *      without an audit trail), THEN flip status='failed' with
 *      `failureReasonCode='stale_pending_sweep'`. If audit emit fails,
 *      updateStatus does not run and the per-row tx rolls back; the
 *      next sweep picks the row up again.
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
import type { AuditPort, ClockPort, LoggerPort, RefundsRepo } from '../ports';
import { noopLogger } from '../ports/logger-port';
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
  /**
   * R2 M-2 (2026-04-27): logger threaded as a port instead of a direct
   * `@/lib/logger` import (Constitution Principle III — Application
   * layer must not import framework adapters). Defaults to
   * `noopLogger` so existing call sites remain non-breaking; the
   * cron-route composition root wires the real `paymentsLogger`.
   */
  readonly logger?: LoggerPort;
}

export async function sweepStalePendingRefunds(
  deps: SweepStalePendingRefundsDeps,
  input: SweepStalePendingRefundsInput,
): Promise<Result<SweepStalePendingRefundsOutput, SweepStalePendingRefundsError>> {
  const olderThanHours = input.olderThanHours ?? 24;
  // review-20260428-102639.md S5 closure — upper bound prevents
  // pathological queries (e.g. `olderThanHours=8760` listing every
  // pending refund ever) that risk Vercel function timeout.
  const MAX_OLDER_THAN_HOURS = 720; // 30 days
  if (olderThanHours <= 0 || olderThanHours > MAX_OLDER_THAN_HOURS) {
    return err({
      code: 'sweep_failed',
      cause: `olderThanHours must be 1–${MAX_OLDER_THAN_HOURS}`,
    });
  }
  const nowMs = deps.clock.nowMs();
  const cutoffMs = nowMs - olderThanHours * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);

  let sweptCount = 0;
  let skippedCount = 0;

  // Read phase in its own short tx; each row then processed in its
  // OWN write tx below. Postgres aborts a tx on the first statement
  // error, so a single shared tx would degenerate after one bad row
  // ("current transaction is aborted, commands ignored"). Per-row tx
  // gives the for-loop's catch real "skip + continue" semantics.
  let stale: Awaited<ReturnType<typeof deps.refundsRepo.listPendingOlderThan>>;
  try {
    stale = await deps.paymentsRepo.withTx((tx) =>
      deps.refundsRepo.listPendingOlderThan(tx, input.tenantId, cutoff),
    );
  } catch (cause) {
    // R3 H3-3 (2026-04-28): use constructor.name only — Postgres
    // errors can carry SQL fragments / column names / partial values
    // in `.message` per project log-redact contract. Same hygiene
    // pattern as the row-skip catch below.
    return err({
      code: 'sweep_failed',
      cause: cause instanceof Error ? cause.constructor.name : 'unknown',
    });
  }

  for (const row of stale) {
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        const failedAt = new Date(deps.clock.nowMs());
        const ageMinutes = Math.floor(
          (failedAt.getTime() - row.initiatedAt.getTime()) / 60_000,
        );
        // Audit emits BEFORE state change. If emit throws, updateStatus
        // doesn't run and the per-row tx rolls back; the row stays
        // pending for the next sweep. Guarantees no `failed` row
        // exists without a corresponding audit trail (Constitution
        // Principle I sub-clause #4).
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
        await deps.refundsRepo.updateStatus(tx, {
          refundId: row.id,
          tenantId: input.tenantId,
          nextStatus: 'failed',
          failureReasonCode: 'stale_pending_sweep',
          completedAt: failedAt,
          // Concurrency guard — if a different writer (future webhook
          // charge.refunded → real adapter) finalised this row between
          // our read tx and now, zero rows match → per-row tx rolls
          // back → row keeps its newer terminal state, no audit commits.
          expectedCurrentStatus: 'pending',
        });
      });
      sweptCount += 1;
    } catch (cause) {
      // M-5 (review 2026-04-27): structured pino warn so ops can
      // correlate which row + tenant tripped the sweep. Constructor
      // name only (no error.message) — Postgres errors can carry SQL
      // params + literal values per the project log redact contract.
      // Per-row tx already rolled back, leaving the row in `pending`
      // for the next sweep to retry; skip and continue.
      (deps.logger ?? noopLogger).warn(
        'sweep_stale_pending_refunds.row_skipped',
        {
          tenantId: input.tenantId,
          refundId: row.id,
          paymentId: row.paymentId,
          errKind:
            cause instanceof Error ? cause.constructor.name : 'unknown',
        },
      );
      skippedCount += 1;
    }
  }

  return ok({
    sweptCount,
    skippedCount,
    cutoff: cutoff.toISOString(),
  });
}
