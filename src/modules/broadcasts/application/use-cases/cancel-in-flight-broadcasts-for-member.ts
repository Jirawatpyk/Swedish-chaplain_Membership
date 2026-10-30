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
 * deleted at Resend (DE4). ERASURE passes `'delete_then_cancel'`, and every
 * decision on such a row is made UNDER the row lock that did the DELETE
 * (review round 1): a cancel decided later, on a status-only CAS, could follow
 * an import tick that re-minted the E-Blast from pre-scrub content in between.
 * Under the lock the cascade makes ONE `deleteBroadcastOnce` and, after a 404
 * or 403, ONE `retrieveBroadcastOnce` — both without backoff and bounded by a
 * 10 s hard timeout; after a 404 it first waits `REPROBE_PAUSE_MS` (3 s, the
 * import leg's re-probe pause, review round 2), so the lock is held for at most
 * ≈ 23 s (D-040). Resend arbitrates the DELETE against the tick's `/send`
 * (DELETE answers 200 only on a draft, `/send` works only on a draft, and
 * after a DELETE both 404):
 *
 *   | DELETE        | GET (under the lock)        | decision                                 |
 *   | 200 deleted   | —                           | cancel, `resendOutcome: 'deleted'`       |
 *   | 404 absent    | not_found                   | cancel, `'absent'` (two not-founds, as   |
 *   |               |                             | the import leg requires)                 |
 *   | 404 absent    | queued / sending / sent     | no row write → `already_sent` evidence   |
 *   | 404 absent    | draft / cancelled / unknown | unexpected (an inconsistent answer)      |
 *   | 403 forbidden | queued / sending / sent     | no row write → `already_sent` evidence   |
 *   | 403 forbidden | cancelled                   | cancel, `'cancelled_at_resend'` (a       |
 *   |               |                             | cancelled broadcast can never be sent)   |
 *   | 403 forbidden | draft / not_found / unknown | unexpected (a restricted key answers 403 |
 *   |               |                             | too; fail closed)                        |
 *   | either call: retryable / other / timeout    | unexpected                               |
 *
 * A cancel happens in the lock tx with its `broadcast_cancelled` row. A tick
 * past its persist then meets a 404 and answers a concurrent skip; an import
 * tick re-minting over the deleted id waits on this lock in its persist CAS
 * and then sees `cancelled`. An unexpected arm throws inside the lock tx, so it
 * rolls back with nothing written; the adapter reports
 * `cascade_partial_failure`, `member_erased` is withheld, and the
 * `reconcile-erasures` cron drives the erasure again.
 *
 * `already_sent` is residual 8c: the row is left as it is (it delivers on its
 * own) and, once the lock tx has ended, `broadcast_concurrent_action_blocked`
 * (`dispatchBegun: true`, `resendOutcome: 'already_sent'`) is written on a tx
 * of its own, under an advisory lock on the broadcast, once per broadcast —
 * a failed write counts unexpected (P6). A lost race whose re-read finds the
 * send already started (`hasSendingStarted`) writes the same evidence in the
 * erasure mode. `alreadySentCount` is DERIVED at the end of every erasure run
 * from the evidence the member holds (distinct broadcasts), never accumulated,
 * so a re-drive with nothing left in flight still reports it (P7).
 *
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
import { hasSendingStarted, isInProgress } from '../../domain/stage/in-progress-statuses';
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
import { REPROBE_PAUSE_MS, sleepBeforeReprobe } from './_reprobe-pause';

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
   * Spec 139 P7 — the member's E-Blasts Resend had ALREADY accepted for
   * sending when the erasure got to them: the DISTINCT broadcasts with an
   * `already_sent` evidence row for this member, read at the end of every
   * erasure run (derived, never accumulated — a re-drive's count is
   * authoritative). Always 0 in the `'skip'` mode. The members adapter carries
   * it into the `member_erased` payload, so "clean" can no longer hide a sent
   * E-Blast.
   */
  readonly alreadySentCount: number;
}

export interface CancelInFlightForMemberDeps {
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Spec 139 — read only in the `'delete_then_cancel'` mode, under the row lock. */
  readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcastOnce'>;
  /**
   * Spec 139 review round 2 (code-review #1) — waits `REPROBE_PAUSE_MS` between
   * a DELETE 404 and its confirming GET, as the import leg waits before its own
   * re-probe. Default: a timer; tests pass a recorder.
   */
  readonly pauseBeforeReprobe?: (ms: number) => Promise<void>;
}

/**
 * Spec 139 — the erasure mode's DELETE (or the probe after it) did not settle
 * the row. Thrown inside the locked tx so it rolls back with nothing written,
 * and the row is counted unexpected; `outcome` names what Resend answered
 * (`<delete>` or `<delete>_probe_<probe>`), for the log and the runbook.
 */
class DispatchBegunUnresolvedError extends Error {
  constructor(public readonly outcome: string) {
    super(`dispatch-begun row not settled at Resend (${outcome})`);
    this.name = 'DispatchBegunUnresolvedError';
  }
}

/** What Resend's answers decided for a dispatch-begun row, under the lock. */
type ResendSettlement =
  | { readonly kind: 'cancel'; readonly resendOutcome: 'deleted' | 'absent' | 'cancelled_at_resend' }
  | { readonly kind: 'already_sent'; readonly resendStatus: 'queued' | 'sending' | 'sent' };

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
  const onDispatchBegun = input.onDispatchBegun ?? 'skip';
  const erasure = onDispatchBegun === 'delete_then_cancel';
  const logBase = {
    tenantId: input.tenant.slug,
    memberId: input.memberId as string,
    useCase: 'cancel-in-flight-broadcasts-for-member',
  };

  try {
    const inFlight: ReadonlyArray<Broadcast> =
      await deps.broadcastsRepo.listInFlightOwnedByMember(
        input.tenant.slug,
        input.memberId,
      );

    let cancelledCount = 0;
    let skippedConcurrentCount = 0;
    let unexpectedErrorCount = 0;

    const countUnexpected = (e: unknown, broadcast: Broadcast, fromStatus: BroadcastStatus, msg: string): void => {
      // Stop-the-line metric + structured error log (the error CLASS only,
      // never its message); the cascade continues to the next broadcast
      // (best-effort) so a single bad row does not block the rest.
      unexpectedErrorCount += 1;
      broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'unexpected_error');
      logger.error(
        {
          ...logBase,
          err: errKind(e),
          broadcastId: broadcast.broadcastId as string,
          previousStatus: fromStatus,
          // Spec 139 — what Resend answered, when that is why it failed.
          ...(e instanceof DispatchBegunUnresolvedError ? { resendOutcome: e.outcome } : {}),
        },
        msg,
      );
    };

    /**
     * Spec 139 — the row's Resend answers, UNDER its lock (the table in the
     * docblock). Two bounded calls at most; anything that does not decide the
     * row throws, and the lock tx rolls back.
     */
    const settleAtResend = async (broadcast: Broadcast, resendId: string): Promise<ResendSettlement> => {
      const startedAt = Date.now();
      const deleted = await deps.broadcastsGateway.deleteBroadcastOnce(resendId);
      const deleteMs = Date.now() - startedAt;
      if (deleted.kind === 'deleted') {
        logger.info(
          { ...logBase, broadcastId: broadcast.broadcastId as string, resendBroadcastId: resendId, outcome: deleted.kind, deleteMs },
          'broadcasts.cascade.dispatch_begun_delete',
        );
        return { kind: 'cancel', resendOutcome: 'deleted' };
      }
      if (deleted.kind !== 'absent' && deleted.kind !== 'forbidden') {
        throw new DispatchBegunUnresolvedError(deleted.kind);
      }
      // Review round 2 (code-review #1) — two not-founds need time between
      // them, or the GET can repeat a stale 404 for a send Resend accepted:
      // the same pause the import leg takes before it re-mints. Not after a
      // 403, which is not a not-found.
      if (deleted.kind === 'absent') {
        await (deps.pauseBeforeReprobe ?? sleepBeforeReprobe)(REPROBE_PAUSE_MS);
      }
      const probe = await deps.broadcastsGateway.retrieveBroadcastOnce(resendId);
      const probed = probe.kind === 'present' ? probe.status : probe.kind;
      logger.info(
        {
          ...logBase,
          broadcastId: broadcast.broadcastId as string,
          resendBroadcastId: resendId,
          outcome: deleted.kind,
          probe: probed,
          // Both calls (and the pause after a 404): the time the row lock was held for Resend.
          resendMs: Date.now() - startedAt,
          deleteMs,
        },
        'broadcasts.cascade.dispatch_begun_delete',
      );
      if (isHandedStatus(probed)) return { kind: 'already_sent', resendStatus: probed };
      if (deleted.kind === 'absent' && probed === 'not_found') return { kind: 'cancel', resendOutcome: 'absent' };
      // A 403 to a DELETE of a cancelled broadcast (MEASURED): only a draft
      // can be sent, so nothing of it can go out — the gate's arm, too.
      if (deleted.kind === 'forbidden' && probed === 'cancelled') return { kind: 'cancel', resendOutcome: 'cancelled_at_resend' };
      throw new DispatchBegunUnresolvedError(`${deleted.kind}_probe_${probed}`);
    };

    /**
     * Spec 139 residual 8c — the durable `already_sent` evidence row, on a tx
     * of its own (never `emit(null)`): the read takes the broadcast's evidence
     * advisory lock first, so two re-drives cannot both miss it and write two.
     * Returns whether a row was written (a re-erasure finds it already there).
     * Throws on a failed write — the caller counts it unexpected (P6).
     */
    const recordAlreadySent = async (
      broadcast: Broadcast,
      observed: { readonly status: BroadcastStatus | null; readonly resendStatus: 'queued' | 'sending' | 'sent' | null },
    ): Promise<void> => {
      const emitted = await deps.broadcastsRepo.withTx(async (tx): Promise<boolean> => {
        const seen = await deps.broadcastsRepo.readAlreadySentEvidenceInTx(tx, input.tenant.slug, {
          memberId: input.memberId as string,
          broadcastId: broadcast.broadcastId,
        });
        if (seen.broadcastRecorded) return false;
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
            observedStatus: observed.status,
            dispatchBegun: true,
            resendOutcome: 'already_sent',
            // `null` when the row itself showed the send had started (a lost
            // race) and Resend was not asked.
            observedResendStatus: observed.resendStatus,
          },
          requestId: input.requestId,
        });
        return true;
      });
      if (emitted) broadcastsMetrics.auditEmitCount(input.tenant.slug, 'broadcast_concurrent_action_blocked');
      logger.warn(
        {
          ...logBase,
          broadcastId: broadcast.broadcastId as string,
          observedStatus: observed.status,
          observedResendStatus: observed.resendStatus,
          evidenceExisted: !emitted,
        },
        'broadcasts.cascade.dispatch_begun_already_sent',
      );
    };

    /**
     * One cancel attempt in its own tx. `lost` = the CAS matched nothing, or
     * the row is gone (the caller re-reads); `dispatch_begun` = the locked row
     * is `approved` and already handed over (D1 — the caller skips it; the
     * `'skip'` mode only); `already_sent` = spec 139's handed arm, decided under
     * the lock and its evidence written after it; every other outcome is final
     * and already counted.
     *
     * F119 round-4 B6 — every throw LEAVES the tx, so the tx rolls back. The
     * attempt used to catch inside `withTx` and return normally, which
     * COMMITTED a cancel whose `broadcast_cancelled` audit emit had thrown: a
     * cancel with no audit row. The counters move only once the tx committed.
     * CR#7 — the tx answers what it decided as a value, never through closure
     * variables.
     */
    const cancelOnce = async (
      broadcast: Broadcast,
      fromStatus: BroadcastStatus,
    ): Promise<{ readonly kind: 'cancelled' | 'lost' | 'dispatch_begun' | 'already_sent' | 'unexpected' }> => {
      type Settled =
        | { readonly kind: 'cancelled' | 'dispatch_begun' }
        | { readonly kind: 'already_sent'; readonly lockedStatus: BroadcastStatus; readonly resendStatus: 'queued' | 'sending' | 'sent' };
      let settled: Settled;
      try {
        settled = await deps.broadcastsRepo.withTx(async (tx): Promise<Settled> => {
          // D1 — lock, THEN read: an in-flight attach commits before this read
          // returns, so its id is seen. Nothing is written on the skip, so the
          // tx ends clean. The CAS below stays on `fromStatus`; a locked row
          // at any other status fails it and takes the caller's re-read.
          await deps.broadcastsRepo.lockForUpdate(tx, input.tenant.slug, broadcast.broadcastId);
          const locked = await deps.broadcastsRepo.findByIdInTx(tx, input.tenant.slug, broadcast.broadcastId);
          if (locked === null) throw new BroadcastConcurrentMutationError(input.tenant.slug, broadcast.broadcastId, fromStatus);
          let resendOutcome: 'deleted' | 'absent' | 'cancelled_at_resend' | null = null;
          if (locked.status === 'approved' && locked.resendBroadcastId !== null) {
            if (!erasure) return { kind: 'dispatch_begun' };
            if (locked.resendBroadcastId !== '') {
              // Review round 2 (M-NEW-1) — the CAS below is on `fromStatus`; a
              // row locked at another status cannot be cancelled by this
              // attempt, so no Resend call is made for it. The caller re-reads
              // and retries from the status it observes.
              if (locked.status !== fromStatus) {
                throw new BroadcastConcurrentMutationError(input.tenant.slug, broadcast.broadcastId, fromStatus);
              }
              const settlement = await settleAtResend(broadcast, locked.resendBroadcastId);
              if (settlement.kind === 'already_sent') {
                // Decided under the lock; nothing is written on the row.
                return { kind: 'already_sent', lockedStatus: locked.status, resendStatus: settlement.resendStatus };
              }
              resendOutcome = settlement.resendOutcome;
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
              // Spec 139 DE2 — set only when the erasure mode settled the
              // row's draft at Resend first.
              ...(resendOutcome !== null ? { resendOutcome } : {}),
            },
            requestId: input.requestId,
          });
          return { kind: 'cancelled' };
        });
      } catch (e) {
        // The CAS matched nothing: another writer moved the row. Where to
        // is the caller's re-read, not this error's `observedStatus`.
        if (e instanceof BroadcastConcurrentMutationError) return { kind: 'lost' };
        // Unexpected: tx error, audit emit error, an unsettled Resend answer
        // — rolled back, so the broadcast remains in flight.
        countUnexpected(e, broadcast, fromStatus, 'broadcasts.cascade.tx_or_audit_failed');
        return { kind: 'unexpected' };
      }
      if (settled.kind === 'dispatch_begun') return { kind: 'dispatch_begun' };
      if (settled.kind === 'already_sent') {
        try {
          await recordAlreadySent(broadcast, { status: settled.lockedStatus, resendStatus: settled.resendStatus });
        } catch (e) {
          countUnexpected(e, broadcast, fromStatus, 'broadcasts.cascade.tx_or_audit_failed');
          return { kind: 'unexpected' };
        }
        // CR#9 — its own label: the mail went out, which is not a benign skip.
        broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'already_sent');
        return { kind: 'already_sent' };
      }
      broadcastsMetrics.auditEmitCount(
        input.tenant.slug,
        'broadcast_cancelled',
      );
      broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'cancelled');
      cancelledCount += 1;
      return { kind: 'cancelled' };
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
          // P7 (a) — the send started before the cascade got the row: that is
          // residual 8c too, so the erasure records its evidence — ONE row
          // (review round 2, reliability LOW-1): not the best-effort skip row,
          // which would call a send the erasure could not stop a benign
          // concurrent transition. Counted as already sent, not as a skip.
          if (erasure && current !== null && hasSendingStarted(current.status)) {
            try {
              await recordAlreadySent(broadcast, { status: current.status, resendStatus: null });
              broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'already_sent');
            } catch (e) {
              countUnexpected(e, broadcast, fromStatus, 'broadcasts.cascade.tx_or_audit_failed');
            }
            break;
          }
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

    // P7 — DERIVED, never accumulated: every E-Blast of this member Resend had
    // already accepted, from the evidence rows, so a re-drive with nothing
    // left in flight still reports it. Erasure mode only (archive never writes
    // that evidence). A failed read is unexpected, so `member_erased` is
    // withheld and the reconciler asks again.
    let alreadySentCount = 0;
    if (erasure) {
      try {
        const evidence = await deps.broadcastsRepo.withTx((tx) =>
          deps.broadcastsRepo.readAlreadySentEvidenceInTx(tx, input.tenant.slug, {
            memberId: input.memberId as string,
            broadcastId: null,
          }),
        );
        alreadySentCount = evidence.memberBroadcastCount;
      } catch (e) {
        unexpectedErrorCount += 1;
        broadcastsMetrics.cascadeOutcome(input.tenant.slug, 'unexpected_error');
        logger.error({ ...logBase, err: errKind(e) }, 'broadcasts.cascade.already_sent_count_failed');
      }
    }

    if (inFlight.length > 0 || alreadySentCount > 0 || unexpectedErrorCount > 0) {
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
    }

    return ok({ cancelledCount, skippedConcurrentCount, unexpectedErrorCount, alreadySentCount });
  } catch (e) {
    return err({
      kind: 'cascade.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}
