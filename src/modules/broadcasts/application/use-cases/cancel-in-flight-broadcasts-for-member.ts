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
 *
 * Each attempt LOCKS the row and reads it inside its tx before the CAS (PR
 * #392 review D1, the pattern `cancel-broadcast.ts` took in round-4 B4). The
 * dispatch leg commits its own lock, then attaches the Resend id in a later
 * tx and calls `sendBroadcast` with no lock held — possibly not until the
 * next tick after a retryable failure. A status-only CAS on `approved`
 * matched such a row, so it read `cancelled` and freed the allowance while
 * the email went out. Under the lock the read sees the attach, and an
 * `approved` row that already has a Resend broadcast (`resend_broadcast_id`)
 * is left to deliver: skipped and audited `broadcast_concurrent_action_blocked`
 * (`dispatchBegun: true`), exactly like a row that moved on to `sending`.
 *
 * Narrower than `hasDispatchBegun` on purpose: an import-leg row with ONLY
 * `audience_import_id` has no email minted yet, and every audience tick
 * re-checks `approved` under its own lock before `createBroadcast`. Cancelling
 * it is safe, and skipping it would let that tick mint the email from the
 * row the erasure scrub has just redacted (`[redacted]` content).
 *
 * Since 2026-10-29 BOTH legs persist `resend_broadcast_id` BEFORE `/send`
 * (the import leg's S8 fix mirrors the legacy F4), so the skip above also
 * covers a row whose resource was minted but whose send has not happened yet:
 * normally a gap of one DB write, but a retryable send failure or a dead tick
 * stretches it to the next tick (≥ 5 min). On the import leg that resource was
 * minted BEFORE the content scrub, so it carries the pre-scrub subject, body
 * and from-name.
 *
 * Spec 139 DE2 — so the caller chooses (`onDispatchBegun`). ARCHIVE (and bulk
 * archive) keep `'skip'`, the default: the row is left to deliver, nothing is
 * deleted at Resend (DE4). ERASURE passes `'delete_then_cancel'`: under the
 * same row lock the cascade makes ONE `deleteBroadcastOnce` (no backoff, a
 * 10 s hard timeout — the lock is held across it, D-039), and Resend arbitrates
 * it against the tick's `/send` (DELETE answers 200 only on a draft, `/send`
 * works only on a draft, and after a DELETE it 404s):
 *   - `deleted` / `absent` → cancelled in the same tx; `broadcast_cancelled`
 *     carries `resendOutcome`. A tick past its persist then meets a 404 and
 *     answers a concurrent skip; an import tick re-minting over the deleted id
 *     waits on this lock in its persist CAS and then sees `cancelled`.
 *   - `forbidden` (403) → the lock tx ends with nothing written, then the id
 *     is probed, because a restricted key answers 403 too (P5). The probe
 *     retries and the SDK has no timeout, so it never runs under the lock
 *     (D-039); a queued / sending / sent broadcast never returns to draft, so
 *     deciding after the lock is safe. `queued` / `sending` / `sent` means
 *     Resend had already accepted the send (residual 8c): the row is left as
 *     it is and `broadcast_concurrent_action_blocked` (`dispatchBegun: true`,
 *     `resendOutcome: 'already_sent'`) is written on its own tx, once per
 *     broadcast (a re-erasure that finds it already there writes none) — a
 *     failed write counts unexpected (P6); `alreadySentCount` carries it to
 *     `member_erased` (P7) on every run. Any other probe answer is unexpected.
 *   - `retryable` (a timeout included — the DELETE may have landed) / `other`
 *     → unexpected, the row unchanged; the adapter reports
 *     `cascade_partial_failure`, `member_erased` is withheld, and the
 *     `reconcile-erasures` cron drives the erasure again.
 * An EMPTY id is not an id: the row is cancelled without a Resend call.
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
import type { CascadeCancellationReason } from '../../domain/value-objects/cascade-cancellation-reason';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import {
  BroadcastConcurrentMutationError,
  type BroadcastsRepo,
} from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import { isHandedStatus } from './_probe-refused-send';

export type CancelInFlightForMemberError =
  | { readonly kind: 'cascade.server_error'; readonly message: string };

/**
 * Round 3 type-design fix — the bounded enum lives in this module's Domain
 * (`cascade-cancellation-reason.ts`, spec 139 CR#8) and mirrors
 * `SystemCancellationReason` in the F3 cascade port, so this F7 use case does
 * not import F3 types (Clean Architecture — F7 has no compile dep on F3).
 */
export type { CascadeCancellationReason };

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
  /**
   * Spec 139 DE2 / DE4 — what to do with an `approved` row that already
   * carries a Resend broadcast id. `'skip'` (the default — archive, bulk
   * archive): leave it to deliver. `'delete_then_cancel'` (erasure only):
   * delete the draft at Resend under the row lock, then cancel (docblock).
   */
  readonly onDispatchBegun?: 'skip' | 'delete_then_cancel';
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
  /**
   * Spec 139 P7 — rows whose E-Blast Resend had ALREADY accepted for sending
   * when the erasure's DELETE arrived (403 + a `queued` / `sending` / `sent`
   * probe): left as they are, each with its `already_sent` audit row. Always
   * 0 in the `'skip'` mode. The members adapter carries it into the
   * `member_erased` payload, so "clean" can no longer hide a sent E-Blast.
   */
  readonly alreadySentCount: number;
}

export interface CancelInFlightForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Spec 139 — read only in the `'delete_then_cancel'` mode. */
  readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcast'>;
}

/**
 * Spec 139 — the erasure mode's DELETE (or the probe after a 403) did not
 * settle the row. Thrown inside the locked tx (or after it, for a 403 probe)
 * so nothing is written and the row is counted unexpected; `outcome` names
 * what Resend answered, for the log.
 */
class DispatchBegunUnresolvedError extends Error {
  constructor(public readonly outcome: string) {
    super(`dispatch-begun row not settled at Resend (${outcome})`);
    this.name = 'DispatchBegunUnresolvedError';
  }
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
        alreadySentCount: 0,
      });
    }

    const onDispatchBegun = input.onDispatchBegun ?? 'skip';
    let cancelledCount = 0;
    let skippedConcurrentCount = 0;
    let alreadySentCount = 0;

    let unexpectedErrorCount = 0;

    /**
     * One cancel attempt in its own tx. `lost` = the CAS matched nothing, or
     * the row is gone (the caller re-reads); `dispatch_begun` = the locked row
     * is `approved` and already handed over (D1 — the caller skips it; the
     * `'skip'` mode only); `already_sent` = spec 139's 403 arm, probed after
     * the lock tx and its audit row written; every other outcome is final and already
     * counted.
     *
     * F119 round-4 B6 — every throw LEAVES the tx, so the tx rolls back. The
     * attempt used to catch inside `withTx` and return normally, which
     * COMMITTED a cancel whose `broadcast_cancelled` audit emit had thrown: a
     * cancel with no audit row. The counters move only once the tx committed.
     */
    const cancelOnce = async (
      broadcast: Broadcast,
      fromStatus: BroadcastStatus,
    ): Promise<{ readonly kind: 'cancelled' | 'lost' | 'dispatch_begun' | 'already_sent' | 'unexpected' }> => {
      try {
        let forbiddenId: string | null = null;
        let lockedStatus: BroadcastStatus | null = null;
        const settled = await deps.broadcastsRepo.withTx(async (tx): Promise<'cancelled' | 'dispatch_begun' | 'forbidden'> => {
          // D1 — lock, THEN read: an in-flight attach commits before this read
          // returns, so its id is seen. Nothing is written on the skip, so the
          // tx ends clean. The CAS below stays on `fromStatus`; a locked row
          // at any other status fails it and takes the caller's re-read.
          await deps.broadcastsRepo.lockForUpdate(tx, input.tenant.slug, broadcast.broadcastId);
          const locked = await deps.broadcastsRepo.findByIdInTx(tx, input.tenant.slug, broadcast.broadcastId);
          if (locked === null) throw new BroadcastConcurrentMutationError(input.tenant.slug, broadcast.broadcastId, fromStatus);
          lockedStatus = locked.status;
          let resendOutcome: 'deleted' | 'absent' | null = null;
          if (locked.status === 'approved' && locked.resendBroadcastId !== null) {
            if (onDispatchBegun === 'skip') return 'dispatch_begun';
            const resendId = locked.resendBroadcastId;
            if (resendId !== '') {
              // Spec 139 DE2 — ONE DELETE under the row lock (docblock).
              const startedAt = Date.now();
              const outcome = await deps.broadcastsGateway.deleteBroadcastOnce(resendId);
              logger.info(
                {
                  tenantId: input.tenant.slug,
                  broadcastId: broadcast.broadcastId as string,
                  resendBroadcastId: resendId,
                  outcome: outcome.kind,
                  // The DELETE call alone, not the whole time the row lock is held.
                  deleteMs: Date.now() - startedAt,
                  useCase: 'cancel-in-flight-broadcasts-for-member',
                },
                'broadcasts.cascade.dispatch_begun_delete',
              );
              if (outcome.kind === 'deleted' || outcome.kind === 'absent') {
                resendOutcome = outcome.kind;
              } else if (outcome.kind === 'forbidden') {
                // P5 — a 403 is decided AFTER the lock is released: the probe
                // retries (up to 31 s, and the SDK has no timeout), so it may
                // not run under the lock (D-039). Nothing is written here.
                forbiddenId = resendId;
                return 'forbidden';
              } else {
                throw new DispatchBegunUnresolvedError(outcome.kind);
              }
            }
          }
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
              // Spec 139 DE2 — set only when the erasure mode deleted the
              // row's draft at Resend first.
              ...(resendOutcome !== null ? { resendOutcome } : {}),
            },
            requestId: input.requestId,
          });
          return 'cancelled';
        });
        if (settled === 'dispatch_begun') return { kind: 'dispatch_begun' as const };
        if (settled === 'forbidden' && forbiddenId !== null) {
          // P5 — a restricted key answers 403 too: believe "already sent" only
          // from the probe. A queued / sending / sent broadcast never returns to
          // draft, so deciding outside the lock is safe. A probe that throws,
          // or any other answer, counts unexpected; the reconciler re-drives.
          const resendId: string = forbiddenId;
          const probe = await deps.broadcastsGateway.retrieveBroadcast(resendId);
          const status = probe.kind === 'present' ? probe.resource.status : 'not_found';
          if (!isHandedStatus(status)) throw new DispatchBegunUnresolvedError(`forbidden_probe_${status}`);
          // P6 — the residual-8c evidence row on its own tx: a failed write
          // counts unexpected, so `member_erased` is withheld. Written ONCE per
          // broadcast: a re-erasure (manual, or the `reconcile-erasures`
          // re-drive) that finds it already there writes no second one, but
          // still counts the broadcast — `member_erased` must say it was sent.
          const emitted = await deps.broadcastsRepo.withTx(async (tx): Promise<boolean> => {
            if (await deps.broadcastsRepo.hasAlreadySentEvidenceInTx(tx, input.tenant.slug, broadcast.broadcastId)) {
              return false;
            }
            await deps.audit.emit(tx, {
              tenantId: input.tenant.slug,
              eventType: 'broadcast_concurrent_action_blocked',
              actorUserId: input.initiatedByUserId ?? SYSTEM_ACTOR_USER_ID,
              summary: `Erasure cascade could not stop broadcast ${broadcast.broadcastId} — Resend had already accepted it for sending`,
              payload: {
                broadcastId: broadcast.broadcastId,
                memberId: input.memberId as string,
                cascade: 'f3_member_archival_or_erasure',
                snapshotStatus: broadcast.status,
                observedStatus: lockedStatus,
                dispatchBegun: true,
                resendOutcome: 'already_sent',
                observedResendStatus: status,
              },
              requestId: input.requestId,
            });
            return true;
          });
          alreadySentCount += 1;
          if (emitted) broadcastsMetrics.auditEmitCount(input.tenant.slug, 'broadcast_concurrent_action_blocked');
          broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'concurrent_skip');
          logger.warn(
            {
              tenantId: input.tenant.slug,
              broadcastId: broadcast.broadcastId as string,
              memberId: input.memberId as string,
              evidenceExisted: !emitted,
              useCase: 'cancel-in-flight-broadcasts-for-member',
            },
            'broadcasts.cascade.dispatch_begun_already_sent',
          );
          return { kind: 'already_sent' as const };
        }
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
            // Spec 139 — what Resend answered, when that is why it failed.
            ...(e instanceof DispatchBegunUnresolvedError ? { resendOutcome: e.outcome } : {}),
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
    const skipConcurrent = async (
      broadcast: Broadcast,
      observedStatus: BroadcastStatus | null,
      dispatchBegun = false,
    ): Promise<void> => {
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
          dispatchBegun,
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
          summary: dispatchBegun
            ? `Cancel cascade skipped broadcast ${broadcast.broadcastId} — the send was already handed over`
            : `Cancel cascade skipped broadcast ${broadcast.broadcastId} — concurrent transition`,
          payload: {
            broadcastId: broadcast.broadcastId,
            memberId: input.memberId as string,
            cascade: 'f3_member_archival_or_erasure',
            snapshotStatus: broadcast.status,
            observedStatus,
            dispatchBegun,
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
        if (attempt.kind === 'dispatch_begun') {
          await skipConcurrent(broadcast, 'approved', true);
          break;
        }
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
        alreadySentCount,
        onDispatchBegun,
        cascade: 'f3_member_archival_or_erasure',
      },
      'broadcasts.cascade.completed',
    );

    return ok({ cancelledCount, skippedConcurrentCount, unexpectedErrorCount, alreadySentCount });
  } catch (e) {
    return err({
      kind: 'cascade.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
