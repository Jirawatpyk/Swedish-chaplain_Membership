/**
 * T178a (Phase 9) — F3 archival/erasure cascade for F7 in-flight
 * broadcasts. Spec § Edge Cases L353 / Coverage Gap C2 from
 * /speckit.analyze.
 *
 * Invoked by the F3 archival/erasure use-case AFTER the member row
 * mutation commits (or as part of the same transaction when the F3
 * caller passes a tx handle — preferred for atomicity, but supported
 * either way to match F3's existing cascade pattern).
 *
 * Behaviour: for each broadcast owned by `memberId` with
 * `status IN ('submitted', 'approved')`:
 *   1. transition to `status='cancelled'`,
 *      `cancelled_by_user_id = NULL` (system-initiated),
 *      `cancellation_reason = input.cancellationReason ??
 *      'originator_member_deleted'` — F3 callers may pass
 *      `'gdpr_erasure_request'` (Art. 17) or `'pdpa_deletion_request'`
 *      (PDPA §33) for compliance-differentiated forensic trails.
 *   2. emit `broadcast_cancelled` audit. `actorUserId` falls back to
 *      `input.initiatedByUserId ?? 'system'` so the F3 admin who
 *      triggered the archive/erasure is recorded as the audit actor;
 *      `actor_role = 'system'` regardless because the cancel itself is
 *      system-initiated (the member account is the SUBJECT, not the
 *      actor). Summary text is templated off the reason so audit
 *      dashboards read distinctly between archive vs GDPR vs PDPA.
 *   3. release the quota reservation (derived count drops naturally
 *      from the FR-003 query because the broadcast leaves the
 *      `submitted`/`approved` set).
 *
 * No member transactional notification is enqueued — the originating
 * member account is being archived/erased, so a notification email is
 * either undeliverable (erased) or unwanted (archived). Admin
 * dashboards observe via audit-log query (T185) instead.
 *
 * Idempotency: if no in-flight rows exist (member never submitted, or
 * cascade already ran), returns ok({cancelledCount: 0}). Safe to call
 * multiple times.
 *
 * Concurrency: each broadcast row is transitioned independently. If
 * another writer moves the row between the `listInFlightOwnedByMember`
 * snapshot and our `applyTransition`, `applyTransition` THROWS
 * `BroadcastConcurrentMutationError` (the repo guards on observed-status
 * mismatch via `WHERE status = $prev` + `RETURNING`). The error's
 * `observedStatus` is NOT evidence of where the row went (`applyTransition`
 * passes its own expected status through), so the row is RE-READ
 * (F119 T166 R-M3):
 *   - it left the in-progress set (a dispatch worker flipped it to
 *     `sending`, an admin closed it, it is gone) → skipped, audited as
 *     `broadcast_concurrent_action_blocked` — it delivers or closes on its
 *     own;
 *   - it is STILL in progress — F119 added winners that leave it there (a
 *     new working copy, a send to the member, a confirmation, the expiry) →
 *     cancelled again from the status just read, up to `CASCADE_CAS_RETRIES`
 *     more times. Still in progress after that, or a re-read that fails, is
 *     counted as an unexpected error: the adapter reports
 *     `cascade_partial_failure`, `erase-member` does not mark the erasure
 *     complete, and the US2 reconciler re-drives it. Skipping it would leave
 *     an erased member's E-Blast in the round, or dispatched with
 *     `[redacted]` content after the scrub.
 * Any other exception is treated as
 * unexpected-error: the broadcast remains in flight, the cascade
 * continues to the next broadcast (best-effort), and the
 * `broadcasts.cascade.outcome{outcome=unexpected_error}` counter is
 * incremented for stop-the-line alerting (see
 * `BroadcastsCascadeOutcomeMetric` in `src/lib/metrics.ts`).
 */
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { Broadcast } from '../../domain/broadcast';
import { isInProgress } from '../../domain/stage/in-progress-statuses';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type { AuditPort } from '../ports/audit-port';
import {
  BroadcastConcurrentMutationError,
  type BroadcastsRepo,
} from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';

export type CancelInFlightForMemberError =
  | { readonly kind: 'cascade.server_error'; readonly message: string };

/**
 * Round 3 type-design fix — bounded enum mirrors
 * `SystemCancellationReason` in the F3 cascade port. Kept as its own
 * type alias here so this F7 use-case does not import F3 types
 * (Clean Architecture — F7 has no compile dep on F3).
 */
export type CascadeCancellationReason =
  | 'originator_member_deleted'
  | 'gdpr_erasure_request'
  | 'pdpa_deletion_request';

export interface CancelInFlightForMemberInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  /**
   * Reason recorded on each cancelled broadcast. Default
   * `'originator_member_deleted'` matches the spec wording at L353;
   * F3 callers may pass a more specific value for compliance
   * differentiation (GDPR Art. 17 vs PDPA §33 vs default archive).
   */
  readonly cancellationReason?: CascadeCancellationReason;
  readonly requestId: string | null;
  /**
   * Optional actor user id — the F3 admin who initiated the
   * archive/erasure. Recorded in the audit `payload.initiatedByUserId`
   * for forensic linkage. The `cancelled_by_user_id` column on
   * `broadcasts` remains NULL because the cancellation itself is
   * system-initiated (the member's account is the subject, not the
   * actor).
   */
  readonly initiatedByUserId?: string | null;
}

export interface CancelInFlightForMemberOutput {
  readonly cancelledCount: number;
  readonly skippedConcurrentCount: number;
  /**
   * Round 5 review fix — surface per-broadcast unexpected errors to F3
   * callers. Previously this count was only logged + emitted as a metric
   * inside the loop, so the F3 cascade adapter saw `outcome: 'ok'` even
   * when 5/5 broadcasts hit `unexpected_error`. Now F3 can branch on
   * this count and translate it to `'cascade_partial_failure'` so a
   * partial cascade is auditable in the F3 caller, not just dashboards.
   */
  readonly unexpectedErrorCount: number;
}

export interface CancelInFlightForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

const SYSTEM_ACTOR_USER_ID = 'system';

/**
 * T166 R-M3 — how many times a lost CAS on a row that is STILL in progress is
 * re-read and retried before the row is counted as an unexpected error (and
 * so re-driven by the US2 reconciler). Each retry is a fresh short tx.
 */
export const CASCADE_CAS_RETRIES = 3;
const DEFAULT_REASON = 'originator_member_deleted';

function cascadeReasonSummary(reason: CascadeCancellationReason): string {
  switch (reason) {
    case 'gdpr_erasure_request':
      return 'GDPR Art. 17 erasure of originator member';
    case 'pdpa_deletion_request':
      return 'PDPA §33 deletion of originator member';
    case 'originator_member_deleted':
      return 'originator member archived';
  }
}

export async function cancelInFlightBroadcastsForMember(
  deps: CancelInFlightForMemberDeps,
  input: CancelInFlightForMemberInput,
): Promise<
  Result<CancelInFlightForMemberOutput, CancelInFlightForMemberError>
> {
  const reason = input.cancellationReason ?? DEFAULT_REASON;
  const now = deps.clock.now();

  try {
    const inFlight: ReadonlyArray<Broadcast> =
      await deps.broadcastsRepo.listInFlightOwnedByMember(
        input.tenant.slug,
        input.memberId,
      );

    if (inFlight.length === 0) {
      return ok({
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        unexpectedErrorCount: 0,
      });
    }

    let cancelledCount = 0;
    let skippedConcurrentCount = 0;

    let unexpectedErrorCount = 0;

    /**
     * One cancel attempt in its own tx. `lost` = the CAS matched nothing (the
     * caller re-reads); every other outcome is final and already counted.
     *
     * F119 round-4 B6 — every throw LEAVES the tx, so the tx rolls back. The
     * attempt used to catch inside `withTx` and return normally, which
     * COMMITTED a cancel whose `broadcast_cancelled` audit emit had thrown: a
     * cancel with no audit row. The counters move only once the tx committed.
     */
    const cancelOnce = async (
      broadcast: Broadcast,
      fromStatus: BroadcastStatus,
    ): Promise<{ readonly kind: 'cancelled' | 'lost' | 'unexpected' }> => {
      try {
        await deps.broadcastsRepo.withTx(async (tx) => {
          const cancelled = await deps.broadcastsRepo.applyTransition(
            tx,
            input.tenant.slug,
            broadcast.broadcastId,
            'cancelled',
            {
              cancelledAt: now,
              cancelledByUserId: null,
              cancellationReason: reason,
            },
            fromStatus,
          );

          await deps.audit.emit(tx, {
            tenantId: input.tenant.slug,
            eventType: 'broadcast_cancelled',
            actorUserId: input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
            // Round 5 review fix — template summary off the reason so
            // GDPR Art. 17 vs PDPA §33 vs default archive read
            // distinctly in the audit-log dashboard. Maps each enum
            // value to its compliance-friendly phrasing rather than
            // hardcoding "archived/erased" for all three.
            summary: `Broadcast ${broadcast.broadcastId} cancelled — ${cascadeReasonSummary(reason)}`,
            payload: {
              broadcastId: broadcast.broadcastId,
              actorKind: 'system',
              actorRole: 'system',
              cancellationReason: reason,
              cancelledAt: now.toISOString(),
              memberId: input.memberId as string,
              initiatedByUserId: input.initiatedByUserId ?? null,
              previousStatus: fromStatus,
              cascade: 'f3_member_archival_or_erasure',
              cancelledBroadcastId: cancelled.broadcastId as string,
            },
            requestId: input.requestId,
          });
        });
      } catch (e) {
        // The CAS matched nothing: another writer moved the row. Where to
        // is the caller's re-read, not this error's `observedStatus`.
        if (e instanceof BroadcastConcurrentMutationError) return { kind: 'lost' as const };
        // Unexpected: tx error, audit emit error, or any non-concurrent
        // throw — rolled back, so the broadcast remains in flight.
        // Stop-the-line metric + structured error log (the error CLASS
        // only, never its message); cascade continues to next broadcast
        // (best-effort) so a single bad row does not block the rest of the
        // member's archival.
        unexpectedErrorCount += 1;
        broadcastsMetrics.cascadeOutcome(
          input.tenant.slug,
          'unexpected_error',
        );
        logger.error(
          {
            err: errKind(e),
            tenantId: input.tenant.slug,
            broadcastId: broadcast.broadcastId as string,
            memberId: input.memberId as string,
            previousStatus: fromStatus,
            useCase: 'cancel-in-flight-broadcasts-for-member',
          },
          'broadcasts.cascade.tx_or_audit_failed',
        );
        return { kind: 'unexpected' as const };
      }
      broadcastsMetrics.auditEmitCount(
        input.tenant.slug,
        'broadcast_cancelled',
      );
      broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'cancelled');
      cancelledCount += 1;
      return { kind: 'cancelled' as const };
    };

    /**
     * The row left the in-progress set under us (or is gone): it delivers or
     * closes on its own. Skip + audit (best-effort) + continue.
     */
    const skipConcurrent = async (broadcast: Broadcast, observedStatus: BroadcastStatus | null): Promise<void> => {
      skippedConcurrentCount += 1;
      broadcastsMetrics.cascadeOutcome(
        input.tenant.slug,
        'concurrent_skip',
      );
      logger.warn(
        {
          tenantId: input.tenant.slug,
          broadcastId: broadcast.broadcastId as string,
          memberId: input.memberId as string,
          previousStatus: broadcast.status,
          observedStatus,
          useCase: 'cancel-in-flight-broadcasts-for-member',
        },
        'broadcasts.cascade.concurrent_skip',
      );
      try {
        await deps.audit.emit(null, {
          tenantId: input.tenant.slug,
          eventType: 'broadcast_concurrent_action_blocked',
          actorUserId:
            input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
          summary: `Cancel cascade skipped broadcast ${broadcast.broadcastId} — concurrent transition`,
          payload: {
            broadcastId: broadcast.broadcastId,
            memberId: input.memberId as string,
            cascade: 'f3_member_archival_or_erasure',
            snapshotStatus: broadcast.status,
            observedStatus,
          },
          requestId: input.requestId,
        });
      } catch (auditErr) {
        broadcastsMetrics.auditEmitFailed(
          'broadcast_concurrent_action_blocked',
          input.tenant.slug,
        );
        logger.error(
          {
            err: errKind(auditErr),
            tenantId: input.tenant.slug,
            broadcastId: broadcast.broadcastId as string,
          },
          'broadcasts.cascade.audit_emit_failed',
        );
      }
    };

    for (const broadcast of inFlight) {
      // Each broadcast cancelled in its own short tx so a single race
      // does not roll back the whole cascade. F3 archival audit on
      // the member row is independent. A lost CAS re-reads and retries in a
      // FRESH tx (T166 R-M3, docblock above).
      let fromStatus: BroadcastStatus = broadcast.status;
      for (let retries = 0; ; retries += 1) {
        const attempt = await cancelOnce(broadcast, fromStatus);
        if (attempt.kind !== 'lost') break;
        let current: Broadcast | null;
        try {
          current = await deps.broadcastsRepo.findById(input.tenant.slug, broadcast.broadcastId);
        } catch (readErr) {
          unexpectedErrorCount += 1;
          broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'unexpected_error');
          logger.error(
            {
              err: errKind(readErr),
              tenantId: input.tenant.slug,
              broadcastId: broadcast.broadcastId as string,
              memberId: input.memberId as string,
              useCase: 'cancel-in-flight-broadcasts-for-member',
            },
            'broadcasts.cascade.reread_failed',
          );
          break;
        }
        if (current === null || !isInProgress(current.status)) {
          await skipConcurrent(broadcast, current?.status ?? null);
          break;
        }
        if (retries >= CASCADE_CAS_RETRIES) {
          unexpectedErrorCount += 1;
          broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'unexpected_error');
          logger.error(
            {
              tenantId: input.tenant.slug,
              broadcastId: broadcast.broadcastId as string,
              memberId: input.memberId as string,
              observedStatus: current.status,
              attempts: retries + 1,
              useCase: 'cancel-in-flight-broadcasts-for-member',
            },
            'broadcasts.cascade.still_in_flight',
          );
          break;
        }
        fromStatus = current.status;
      }
    }

    logger.info(
      {
        tenantId: input.tenant.slug,
        memberId: input.memberId as string,
        cancelledCount,
        skippedConcurrentCount,
        unexpectedErrorCount,
        cascade: 'f3_member_archival_or_erasure',
      },
      'broadcasts.cascade.completed',
    );

    return ok({ cancelledCount, skippedConcurrentCount, unexpectedErrorCount });
  } catch (e) {
    return err({
      kind: 'cascade.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
