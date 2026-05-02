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
 *      `cancellation_reason = 'originator_member_deleted'`.
 *   2. emit `broadcast_cancelled` audit with `actor_role = 'system'`
 *      so audit-log dashboards can distinguish member-self / admin /
 *      system cancellations.
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
 * Concurrency: each broadcast row is transitioned independently. If a
 * dispatch worker races us to flip an `approved` → `sending` between
 * the `listInFlightOwnedByMember` snapshot and our `applyTransition`,
 * `applyTransition` THROWS `BroadcastConcurrentMutationError` (the
 * repo guards on observed-status mismatch via `WHERE status = $prev`
 * + `RETURNING`) and the broadcast is skipped — it will deliver
 * normally because the member archive happened after the dispatch
 * decision. The skip is audited as `broadcast_concurrent_action_blocked`
 * for forensic trail. Any other exception is treated as
 * unexpected-error: the broadcast remains in flight, the cascade
 * continues to the next broadcast (best-effort), and the
 * `broadcasts.cascade.outcome{outcome=unexpected_error}` counter is
 * incremented for stop-the-line alerting (see
 * `BroadcastsCascadeOutcomeMetric` in `src/lib/metrics.ts`).
 */
import { err, ok, type Result } from '@/lib/result';
import { broadcastsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { Broadcast } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import {
  BroadcastConcurrentMutationError,
  type BroadcastsRepo,
} from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';

export type CancelInFlightForMemberError =
  | { readonly kind: 'cascade.server_error'; readonly message: string };

export interface CancelInFlightForMemberInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  /**
   * Reason recorded on each cancelled broadcast. Default
   * `'originator_member_deleted'` matches the spec wording at L353;
   * F3 callers may pass a more specific string (e.g.
   * `'gdpr_erasure_request'`) for compliance differentiation.
   */
  readonly cancellationReason?: string;
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
}

export interface CancelInFlightForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

const SYSTEM_ACTOR_USER_ID = 'system';
const DEFAULT_REASON = 'originator_member_deleted';

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
      return ok({ cancelledCount: 0, skippedConcurrentCount: 0 });
    }

    let cancelledCount = 0;
    let skippedConcurrentCount = 0;

    let unexpectedErrorCount = 0;

    for (const broadcast of inFlight) {
      // Each broadcast cancelled in its own short tx so a single race
      // does not roll back the whole cascade. F3 archival audit on
      // the member row is independent.
      await deps.broadcastsRepo.withTx(async (tx) => {
        try {
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
            broadcast.status,
          );

          await deps.audit.emit(tx, {
            tenantId: input.tenant.slug,
            eventType: 'broadcast_cancelled',
            actorUserId: input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
            summary: `Broadcast ${broadcast.broadcastId} cancelled — originator member archived/erased`,
            payload: {
              broadcastId: broadcast.broadcastId,
              actorKind: 'system',
              actorRole: 'system',
              cancellationReason: reason,
              cancelledAt: now.toISOString(),
              memberId: input.memberId as string,
              initiatedByUserId: input.initiatedByUserId ?? null,
              previousStatus: broadcast.status,
              cascade: 'f3_member_archival_or_erasure',
              cancelledBroadcastId: cancelled.broadcastId as string,
            },
            requestId: input.requestId,
          });
          broadcastsMetrics.auditEmitCount(
            input.tenant.slug,
            'broadcast_cancelled',
          );
          broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'cancelled');
          cancelledCount += 1;
        } catch (e) {
          if (e instanceof BroadcastConcurrentMutationError) {
            // Expected race: dispatch worker flipped status between our
            // snapshot and applyTransition. Skip + audit + continue.
            skippedConcurrentCount += 1;
            broadcastsMetrics.cascadeOutcome(
              input.tenant.slug,
              'concurrent_skip',
            );
            logger.warn(
              {
                err: e.message,
                tenantId: input.tenant.slug,
                broadcastId: broadcast.broadcastId as string,
                memberId: input.memberId as string,
                previousStatus: broadcast.status,
                observedStatus: e.observedStatus,
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
                  observedStatus: e.observedStatus,
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
                  err:
                    auditErr instanceof Error
                      ? auditErr.message
                      : String(auditErr),
                  tenantId: input.tenant.slug,
                  broadcastId: broadcast.broadcastId as string,
                },
                'broadcasts.cascade.audit_emit_failed',
              );
            }
            return;
          }
          // Unexpected: tx error, audit emit error, or any non-concurrent
          // throw. Broadcast remains in flight. Stop-the-line metric +
          // structured error log; cascade continues to next broadcast
          // (best-effort) so a single bad row does not block the rest
          // of the member's archival.
          unexpectedErrorCount += 1;
          broadcastsMetrics.cascadeOutcome(
            input.tenant.slug,
            'unexpected_error',
          );
          logger.error(
            {
              err: e instanceof Error ? e.message : String(e),
              errName: e instanceof Error ? e.name : undefined,
              tenantId: input.tenant.slug,
              broadcastId: broadcast.broadcastId as string,
              memberId: input.memberId as string,
              previousStatus: broadcast.status,
              useCase: 'cancel-in-flight-broadcasts-for-member',
            },
            'broadcasts.cascade.tx_or_audit_failed',
          );
        }
      });
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

    return ok({ cancelledCount, skippedConcurrentCount });
  } catch (e) {
    return err({
      kind: 'cascade.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
