/**
 * T103 — `cancel-broadcast.ts` Application use-case (F7 US2).
 *
 * Shared between member-self + admin paths per FR-004a / Q10.
 *
 * State-check via Domain `authorizeCancel` policy:
 *   - cancellable iff status IN ('submitted', 'approved')
 *   - REJECTS sending/sent/rejected/cancelled/failed_to_dispatch with
 *     `broadcast_cancel_too_late` (409 + audit)
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
import { logAuditEmitFailure } from '../audit-emit-failure-logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import { authorizeCancel } from '../../domain/policies/cancel-cutoff-policy';
import type { AuditPort } from '../ports/audit-port';
import { BroadcastConcurrentMutationError, type BroadcastsRepo } from '../ports/broadcasts-repo';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { enqueueBroadcastMemberNotification } from '../enqueue-member-notification';
// Verify-fix R4 (Types-#1, 2026-05-02) — see approve-broadcast.ts.
import type { Locale } from '@/i18n/config';
export type NotificationLocale = Locale;

const MAX_REASON_LENGTH = 500;

export type CancelActor =
  | { readonly kind: 'member'; readonly memberId: string; readonly userId: string }
  | { readonly kind: 'admin'; readonly userId: string };

export type CancelBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | { readonly kind: 'broadcast_cancel_too_late'; readonly observedStatus: string }
  | {
      readonly kind: 'broadcast_concurrent_action_blocked';
      readonly observedStatus: string;
    }
  | {
      readonly kind: 'broadcast_cancel_reason_too_long';
      readonly length: number;
    }
  | { readonly kind: 'cancel.server_error'; readonly message: string };

export interface CancelBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
  /** G2 closure (verify-fix 2026-05-02) — best-effort post-cancel email. */
  readonly emailTransactional?: EmailTransactionalPort;
  /** R4 Types-#6 — see approve-broadcast.ts. */
  readonly membersBridge?: MembersBridgePort;
  /**
   * F7.1a US1 FR-004 (Phase 3E.3 fix 2026-05-19) — halt all not-yet-
   * dispatched batch_manifests when the broadcast is cancelled in
   * `sending` state. Optional for backward compat with F7 MVP tests
   * that mock the deps without batch awareness; production factory
   * (`makeCancelBroadcastDeps`) wires the real Drizzle port.
   *
   * When undefined: batches are not halted (F7 MVP behaviour). When
   * provided: cancellation calls `markCancelled(slug, pendingIds)`
   * before the broadcast-row transition so the dispatcher cron can
   * no longer pick up the now-stale pending rows.
   */
  readonly batchManifests?: import('../ports/batch-manifests-port').BatchManifestsPort;
}

export interface CancelBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actor: CancelActor;
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
    return await deps.broadcastsRepo.withTx(async (tx) => {
      const existing = await deps.broadcastsRepo.findByIdInTx(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      if (existing === null) {
        // Phase 3F.11.3 (M1 — Round 2 fix) — emit cross-tenant probe
        // audit on admin probes of unknown broadcasts (mirrors the
        // Phase 3F.1 pattern in retry-failed-batches + accept-partial-
        // delivery). Member-actor branch BELOW intentionally returns
        // the same `broadcast_not_found` shape without audit to avoid
        // existence-leak (a member probing another member's broadcast
        // must get the same response as a probe of a nonexistent one).
        if (input.actor.kind === 'admin') {
          try {
            await deps.audit.emit(null, {
              tenantId: deps.tenant.slug,
              eventType: 'broadcast_cross_tenant_probe',
              actorUserId,
              summary: `Admin ${actorUserId} probed unknown broadcast ${input.broadcastId} (cancel path)`,
              payload: {
                broadcastId: input.broadcastId,
                probedBroadcastId: input.broadcastId,
                expectedTenantId: deps.tenant.slug,
                useCase: 'cancel-broadcast',
              },
              requestId: input.requestId,
            });
          } catch (auditErr) {
            // Phase 3F.11.9 (Round 3 comment-MED) — delegate to
            // canonical helper. See `application/audit-emit-failure-logger.ts`.
            logAuditEmitFailure(logger, {
              err: auditErr,
              tenantId: deps.tenant.slug,
              probedBroadcastId: input.broadcastId as string,
              actorUserId,
              useCase: 'cancel-broadcast',
            });
          }
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

      // Phase 3F.1 (Finding 4 fix) — pre-check pending batches BEFORE
      // policy authorization. The widened `authorizeCancel(status,
      // hasBatches)` accepts `sending` IFF the broadcast was split
      // into batches (F7.1a US1 path). When NO batches exist (F7 MVP
      // single-audience path), the original `sending → cutoff` rule
      // still applies — we can't recall a Resend-accepted broadcast.
      // Phase 3F.11.3 (M1 — Round 2 fix) — skip pending-batch lookup
      // unless status carries batches (saves a DB roundtrip on the
      // common cancel-of-non-multi-audience path).
      let pendingBatchIds: readonly string[] = [];
      let hasBatches = false;
      const statusMightHaveBatches =
        existing.status === 'approved' || existing.status === 'sending';
      if (deps.batchManifests !== undefined && statusMightHaveBatches) {
        const pendingBatches = await deps.batchManifests.findPendingByBroadcast(
          deps.tenant.slug as never,
          input.broadcastId,
        );
        pendingBatchIds = pendingBatches.map((b) => b.id);
        hasBatches = pendingBatchIds.length > 0;
      }

      const policyResult = authorizeCancel(existing.status, hasBatches);
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
            summary: `Cancel rejected — broadcast ${input.broadcastId} in terminal state ${existing.status}`,
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
              err: auditErr instanceof Error ? auditErr.message : String(auditErr),
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              actorUserId,
              phase: 'cancel_too_late',
            },
            'broadcasts.cancel.audit_emit_failed',
          );
        }
        return err({
          kind: 'broadcast_cancel_too_late',
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
      let haltedCount = 0;
      if (hasBatches) {
        haltedCount = await deps.batchManifests!.markCancelled(
          deps.tenant.slug as never,
          pendingBatchIds,
          tx,
        );
        if (haltedCount < pendingBatchIds.length) {
          logger.warn(
            {
              tenantId: deps.tenant.slug,
              broadcastId: input.broadcastId as string,
              requested: pendingBatchIds.length,
              halted: haltedCount,
            },
            'broadcasts.cancel.batch_halt_partial',
          );
        }
      }

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
        return err({
          kind: 'broadcast_concurrent_action_blocked',
          observedStatus: refresh?.status ?? 'unknown',
        });
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
        },
        requestId: input.requestId,
      });

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
                err: e instanceof Error ? e.message : String(e),
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
  } catch (e) {
    return err({
      kind: 'cancel.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

// Verify-fix R4 (Simplify-#2, 2026-05-02): local enqueueCancelledNotification
// helper removed — replaced by shared `enqueueBroadcastMemberNotification`.
