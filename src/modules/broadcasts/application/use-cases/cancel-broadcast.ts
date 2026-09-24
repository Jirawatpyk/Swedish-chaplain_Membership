/**
 * T103 — `cancel-broadcast.ts` Application use-case (F7 US2).
 *
 * Shared between member-self + admin paths per FR-004a / Q10.
 *
 * State-check via Domain `authorizeCancel` policy (widened by F119 T081):
 *   - cancellable at every in-progress stage (`IN_PROGRESS_BROADCAST_STATUSES`
 *     — FR-015: withdrawable at ANY stage before sending begins)
 *   - from `sending` onward → `sending_started` (409): the send completes;
 *     likewise an `approved` row the dispatcher already handed over
 *     (`hasDispatchBegun`, T166 R-H1)
 *   - a closed E-Blast that never started sending (rejected / cancelled /
 *     expired / a failed dispatch) → `broadcast_cancel_too_late` (409)
 *   Both refusals audit `broadcast_cancel_too_late` (the forensic event).
 *
 * F119 T081, in the SAME transaction as the transition:
 *   - every live `broadcast_images` row of the E-Blast is stamped and audited
 *     `broadcast_image_removed { reason: 'withdrawn' }` (the bytes go on the
 *     sweep's next tick, under the last-reference rule — spec § Personal data);
 *   - a MEMBER withdrawal tells the other party (FR-021 "withdrawn → the other
 *     party"): one `eblast_member_decided_marketing { decision: 'withdrawn' }`
 *     row per marketing recipient (FR-021a), ids only. `versionId` is null —
 *     a whole-E-Blast withdrawal concerns no one version — and `round` is the
 *     current round, or null before any round (the arm renders from the
 *     broadcast alone). The enqueue is unconditional; the flag lives at the
 *     drainer (T152a).
 *
 * Authorisation:
 *   - `member` actor: only the originating member
 *   - `admin` actor: any broadcast in tenant
 *   - `manager` actor: filtered at route layer (RBAC `broadcast` write denied)
 *
 * Audit emission:
 *   - Success → `broadcast_cancelled` with actor + actor_role + reason
 *   - State-cutoff fail → `broadcast_cancel_too_late`
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { emitCrossTenantProbe } from './_emit-cross-tenant-probe';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import { authorizeCancel } from '../../domain/policies/cancel-cutoff-policy';
import { hasDispatchBegun } from '../../domain/stage/in-progress-statuses';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { EblastNotificationOutboxPort } from '../ports/eblast-notification-outbox-port';
import type { MarketingDirectoryPort } from '../ports/marketing-directory-port';
import { markOwnerImagesRemoved } from './_mark-owner-images-removed';

import type { AuditPort } from '../ports/audit-port';
import { BroadcastConcurrentMutationError, type BroadcastsRepo } from '../ports/broadcasts-repo';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { enqueueBroadcastMemberNotification } from '../enqueue-member-notification';
// Verify-fix R4 (Types-#1, 2026-05-02) — see approve-broadcast.ts.
import type { Locale } from '@/i18n/config';
export type NotificationLocale = Locale;

const MAX_REASON_LENGTH = 500;

/**
 * Bug #5 (2026-07-10) — thrown from the withTx callback to force a tx
 * ROLLBACK when a concurrent mutation is detected AFTER the batch halts were
 * already applied in the same tx. `return err(...)` from the callback is a
 * NORMAL return that COMMITS the halts while the broadcast-row transition
 * never happened — defeating the F-21 halt-before-transition atomicity and
 * leaving "M batches cancelled + broadcast still sending/sent". Rethrowing
 * this sentinel makes `db.transaction` roll the halts back with the
 * (never-applied) transition; the outer catch maps it to the
 * `broadcast_concurrent_action_blocked` 409. Carries the drifted status for
 * the response payload.
 */
class CancelConcurrentMutationSignal extends Error {
  constructor(public readonly observedStatus: string) {
    super('cancel concurrent mutation — rolling back');
    this.name = 'CancelConcurrentMutationSignal';
  }
}

export type CancelActor =
  | { readonly kind: 'member'; readonly memberId: string; readonly userId: string }
  | { readonly kind: 'admin'; readonly userId: string };

export type CancelBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | { readonly kind: 'broadcast_cancel_too_late'; readonly observedStatus: string }
  /** F119 T081 — from `sending` onward: the send completes (FR-015). */
  | { readonly kind: 'sending_started'; readonly observedStatus: string }
  | {
      readonly kind: 'broadcast_concurrent_action_blocked';
      readonly observedStatus: string;
    }
  | {
      readonly kind: 'broadcast_cancel_reason_too_long';
      readonly length: number;
    }
  /**
   * An infrastructure fault. `errKind` is the error CLASS only (T166 R-M4):
   * the raw message can carry a Neon error's bound parameters, and the route
   * logs what it is handed.
   */
  | { readonly kind: 'cancel.server_error'; readonly errKind: string };

export interface CancelBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'findByIdInTx' | 'applyTransition'>;
  /** F119 T081 — the E-Blast's image rows, stamped in the cancel's tx. */
  readonly imagesRepo: Pick<BroadcastImagesRepo, 'markDeletedByOwner'>;
  /** F119 T081 — who "marketing" is for the member-withdrawal hand-off (FR-021a). */
  readonly marketingDirectory: MarketingDirectoryPort;
  /** F119 T081 — the ids-only approval-round outbox, on the cancel's tx. */
  readonly eblastOutbox: EblastNotificationOutboxPort;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
  /** G2 closure (verify-fix 2026-05-02) — best-effort post-cancel email. */
  readonly emailTransactional?: EmailTransactionalPort;
  /** R4 Types-#6 — see approve-broadcast.ts. */
  readonly membersBridge?: MembersBridgePort;
}

export interface CancelBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actor: CancelActor;
  /**
   * F119 T081 — the SESSION role, recorded as-is on the image-removal audit
   * rows (`check:actor-role-truth`: never a literal stand-in).
   */
  readonly actorRole: string | null;
  readonly cancellationReason: string | null;
  readonly requestId: string | null;
  /** E1 closure (verify-fix 2026-05-02) — locale for notification email. */
  readonly notificationLocale?: NotificationLocale;
}

export interface CancelBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly reservationReleased: true;
}

export async function cancelBroadcast(
  deps: CancelBroadcastDeps,
  input: CancelBroadcastInput,
): Promise<Result<CancelBroadcastOutput, CancelBroadcastError>> {
  if (
    input.cancellationReason !== null &&
    input.cancellationReason.length > MAX_REASON_LENGTH
  ) {
    return err({
      kind: 'broadcast_cancel_reason_too_long',
      length: input.cancellationReason.length,
    });
  }

  const now = deps.clock.now();
  const actorUserId = input.actor.userId;
  const actorRole =
    input.actor.kind === 'member' ? 'member_self_service' : 'admin';

  try {
    // T166 R-L3 — a member withdrawal hands off to marketing; the roster is a
    // pool-global read and is made BEFORE the tx, never while it holds the row
    // lock. Its empty-roster count is paid only once the withdrawal committed.
    const roster = input.actor.kind === 'member' ? await deps.marketingDirectory.readRoster() : [];
    const withdrawn = await deps.broadcastsRepo.withTx<Result<CancelBroadcastOutput, CancelBroadcastError>>(async (tx) => {
      const existing = await deps.broadcastsRepo.findByIdInTx(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      if (existing === null) {
        // Phase 3F.11.3 (M1 — Round 2 fix) + H5 Round 2 closure 2026-05-21
        // (review finding simplifier H5): consolidated to the canonical
        // `emitCrossTenantProbe` helper — mirrors the retry-failed-batches
        // + accept-partial-delivery pattern. Member-actor branch BELOW
        // intentionally returns the same `broadcast_not_found` shape
        // WITHOUT audit emit to avoid existence-leak (member probing
        // another member's broadcast must look identical to a probe of
        // a nonexistent one).
        if (input.actor.kind === 'admin') {
          await emitCrossTenantProbe({
            audit: deps.audit,
            tenantId: deps.tenant.slug,
            actorUserId,
            requestId: input.requestId,
            surface: {
              kind: 'broadcast',
              broadcastId: input.broadcastId as string,
              useCase: 'cancel-broadcast',
            },
          });
        }
        return err({
          kind: 'broadcast_not_found',
          broadcastId: input.broadcastId as string,
        });
      }

      // Member-self: must be the originating member; otherwise treat as
      // not found (no existence leak).
      if (
        input.actor.kind === 'member' &&
        existing.requestedByMemberId !== input.actor.memberId
      ) {
        return err({
          kind: 'broadcast_not_found',
          broadcastId: input.broadcastId as string,
        });
      }

      // `authorizeCancel(status, hasBatches)` was widened so `sending` could be
      // cancelled IFF the broadcast had been split into batches; without them
      // the original rule stands, because a Resend-accepted broadcast cannot be
      // recalled. The batch path is gone (108 US5), so there are no per-batch
      // rows to halt and cancellation is decided by status alone.
      //
      // The `false` is passed as a literal rather than dropping the parameter:
      // this is the policy's only production call site, so removing the argument
      // would delete the batch branch's last documentation of itself, and the
      // policy's own tests still exercise both. Reviewed as a dead branch and
      // kept deliberately — see reviews/review-20260908-223000.md S40.
      //
      // T166 R-H1 — an `approved` row the dispatcher has already handed over
      // (`resend_broadcast_id` / `audience_import_id` set, status not moved
      // yet) is refused `sending_started`, exactly as every other exit from
      // `approved` is. Otherwise the row would read `cancelled` and free the
      // allowance while the email goes out. Decided before any write.
      const policyResult =
        existing.status === 'approved' && hasDispatchBegun(existing)
          ? err({ code: 'sending_started' as const, status: existing.status })
          : authorizeCancel(existing.status, false);
      if (!policyResult.ok) {
        // R7 staff-review MED-R2 — `null` tx is intentional here: the
        // policy reject branch performs NO state mutation (no UPDATE,
        // no INSERT into broadcasts), so emitting the audit on
        // auto-commit is safe — there is no broadcasts-row write that
        // could roll back independently. This DIVERGES from the
        // F5/F4 in-tx-audit pattern but the F5/F4 patterns wrap a
        // mutation; here the audit is the sole side effect of a
        // policy reject. If a future change adds a write to this
        // branch (unlikely — it would conflict with FR-004a's
        // "cancellation rejected" semantic), promote `null` → `tx`.
        try {
          await deps.audit.emit(null, {
            tenantId: deps.tenant.slug,
            eventType: 'broadcast_cancel_too_late',
            actorUserId,
            summary: `Cancel rejected (${policyResult.error.code}) — broadcast ${input.broadcastId} at ${existing.status}`,
            payload: {
              broadcastId: input.broadcastId,
              observedStatus: existing.status,
              actorKind: input.actor.kind,
              actorRole,
            },
            requestId: input.requestId,
          });
        } catch (auditErr) {
          // Round-4 HIGH-A — log audit-emit failure so ops can backfill
          // (no silent swallow on a forensic event).
          logger.error(
            {
              err: errKind(auditErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              actorUserId,
              phase: 'cancel_too_late',
            },
            'broadcasts.cancel.audit_emit_failed',
          );
        }
        return err({
          kind: policyResult.error.code,
          observedStatus: existing.status,
        });
      }

      let cancelled: Broadcast;
      // F7.1a US1 FR-004 (Phase 3F.1 hardening — F-21 atomicity fix).
      // When the broadcast has pending batches (already discovered
      // above for the policy check), halt them BEFORE the broadcast-
      // row transition AND WITHIN the same withTx scope (pass `tx` to
      // markCancelled). If the subsequent applyTransition throws, the
      // outer tx rollback now also reverts the batch halts → no half-
      // committed "M batches cancelled + broadcast still sending"
      // inconsistency. Log halt count for ops observability.

      try {
        // Verify-fix R3 (Code-M1, 2026-05-02): pass `expectedFromStatus`
        // (G1 race-guard) so a concurrent dispatch worker that just
        // transitioned the row to 'sending' between our `findByIdInTx`
        // snapshot (read-committed) and this UPDATE will cause
        // `applyTransition` to return 0 rows → `BroadcastConcurrentMutationError`
        // → caught below + mapped to `broadcast_concurrent_action_blocked`
        // 409. Closes the AS6 race window: cancel cannot silently
        // overwrite 'sending' anymore.
        cancelled = await deps.broadcastsRepo.applyTransition(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          'cancelled',
          {
            cancelledAt: now,
            cancelledByUserId: actorUserId,
            cancellationReason: input.cancellationReason,
          },
          existing.status,
        );
      } catch (e) {
        // R6 staff-review W-R2 fix — narrow catch to the concurrency
        // sentinel only. The prior bare `catch` swallowed any throw,
        // including a Neon outage on the refresh-status `findByIdInTx`
        // call below (which itself can throw). That secondary throw
        // would propagate out of the inner try, get caught by the
        // outer `try/catch` at line 251, and surface as
        // `cancel.server_error` — masking the real concurrency signal
        // and producing the wrong audit-event-kind. Narrowing to
        // `BroadcastConcurrentMutationError` lets DB-layer errors
        // propagate cleanly to the outer catch which logs and returns
        // `cancel.server_error` with the underlying cause.
        if (!(e instanceof BroadcastConcurrentMutationError)) {
          throw e;
        }
        const refresh = await deps.broadcastsRepo.findByIdInTx(
          tx,
          deps.tenant.slug,
          input.broadcastId,
        );
        // Bug #5 fix: DO NOT `return err(...)` here — a normal return COMMITS
        // the tx, leaving the earlier `markCancelled` batch halts applied
        // while the broadcast-row transition never happened. Rethrow a
        // sentinel so `db.transaction` ROLLS BACK (reverting the halts with
        // the never-applied transition); the outer catch maps it to the 409.
        throw new CancelConcurrentMutationSignal(refresh?.status ?? 'unknown');
      }

      await deps.audit.emit(tx, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_cancelled',
        actorUserId,
        summary: `Broadcast ${input.broadcastId} cancelled by ${input.actor.kind}`,
        payload: {
          broadcastId: input.broadcastId,
          actorKind: input.actor.kind,
          actorRole,
          cancellationReason: input.cancellationReason,
          cancelledAt: now.toISOString(),
          // F119 T081 — the stage it was withdrawn / cancelled from.
          previousStatus: existing.status,
        },
        requestId: input.requestId,
      });

      // F119 T081 — the images stop being reachable in the same tx.
      await markOwnerImagesRemoved(
        { imagesRepo: deps.imagesRepo, audit: deps.audit },
        {
          tenantId: deps.tenant.slug,
          owner: { kind: 'broadcast', id: input.broadcastId as string },
          reason: 'withdrawn',
          at: now,
          requestId: input.requestId ?? `cancel-${input.broadcastId as string}`,
          actorUserId,
          actorRole: input.actorRole,
          relatedMemberId: cancelled.requestedByMemberId,
        },
        tx,
      );

      // F119 T081 — a member withdrawal is a hand-off to marketing (FR-021).
      if (input.actor.kind === 'member') {
        for (const recipient of roster) {
          await deps.eblastOutbox.enqueueInTx(tx, deps.tenant, {
            type: 'eblast_member_decided_marketing',
            toEmail: recipient.email,
            locale: recipient.locale,
            contextData: {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              versionId: null,
              round: existing.currentRound >= 1 ? existing.currentRound : null,
              decision: 'withdrawn',
              recipientUserId: recipient.userId,
            },
          });
        }
      }

      // G2 closure (verify-fix 2026-05-02 — US2 wire-up) — notify the
      // originating member. For self-cancel: confirmation. For
      // admin-cancel: the member learns their broadcast was stopped
      // + the (admin-supplied) cancellation reason.
      // Recipient = `replyToEmail` (immutable submit-time snapshot).
      // Verify-fix R4 (Simplify-#2 + Types-#6): shared helper +
      // member-preferred-locale chain.
      if (deps.emailTransactional) {
        let memberPreferred: 'en' | 'th' | 'sv' | null = null;
        if (deps.membersBridge) {
          try {
            memberPreferred = await deps.membersBridge.getMemberPreferredLocale(
              deps.tenant,
              cancelled.requestedByMemberId,
            );
          } catch (e) {
            logger.warn(
              {
                err: errKind(e),
                tenantId: deps.tenant.slug,
                memberId: cancelled.requestedByMemberId,
                useCase: 'cancel-broadcast',
              },
              'broadcasts.locale_resolve_failed',
            );
          }
        }
        await enqueueBroadcastMemberNotification({
          tenant: deps.tenant,
          emailTransactional: deps.emailTransactional,
          broadcast: cancelled,
          variant: {
            templateKey: 'broadcast_cancelled',
            cancellationReason: input.cancellationReason,
          },
          locale: memberPreferred ?? input.notificationLocale ?? 'en',
          tx,
        });
      }

      return ok({ broadcast: cancelled, reservationReleased: true as const });
    });
    if (withdrawn.ok && input.actor.kind === 'member' && roster.length === 0) {
      deps.marketingDirectory.reportEmptyRoster();
    }
    return withdrawn;
  } catch (e) {
    // Bug #5: the concurrency signal was rethrown from inside withTx to force
    // the rollback (batch halts + never-applied transition reverted). Map it
    // to the 409 here — NOT to a generic server_error.
    if (e instanceof CancelConcurrentMutationSignal) {
      return err({
        kind: 'broadcast_concurrent_action_blocked',
        observedStatus: e.observedStatus,
      });
    }
    return err({ kind: 'cancel.server_error', errKind: errKind(e) });
  }
}

// Verify-fix R4 (Simplify-#2, 2026-05-02): local enqueueCancelledNotification
// helper removed — replaced by shared `enqueueBroadcastMemberNotification`.
