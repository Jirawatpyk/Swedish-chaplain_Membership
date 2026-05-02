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
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import { authorizeCancel } from '../../domain/policies/cancel-cutoff-policy';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';

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
  /** G2 closure (verify-fix 2026-05-02 — US2 wire-up). */
  readonly membersBridge?: MembersBridgePort;
  /** G2 closure — best-effort post-cancel member email. */
  readonly emailTransactional?: EmailTransactionalPort;
}

export interface CancelBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actor: CancelActor;
  readonly cancellationReason: string | null;
  readonly requestId: string | null;
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

      const policyResult = authorizeCancel(existing.status);
      if (!policyResult.ok) {
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
      try {
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
        );
      } catch {
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
      // originating member. For self-cancel paths the member receives
      // a confirmation; for admin-cancel paths the member learns
      // their broadcast was stopped + the (admin-supplied)
      // cancellation reason.
      if (deps.emailTransactional && deps.membersBridge) {
        await enqueueCancelledNotification({
          tenant: deps.tenant,
          membersBridge: deps.membersBridge,
          emailTransactional: deps.emailTransactional,
          broadcast: cancelled,
          cancellationReason: input.cancellationReason,
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

async function enqueueCancelledNotification(args: {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly emailTransactional: EmailTransactionalPort;
  readonly broadcast: Broadcast;
  readonly cancellationReason: string | null;
  readonly tx: unknown;
}): Promise<void> {
  let memberEmail: string | null;
  try {
    memberEmail = await args.membersBridge.getMemberPrimaryContact(
      args.tenant,
      args.broadcast.requestedByMemberId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenant.slug,
        broadcastId: args.broadcast.broadcastId as string,
      },
      'broadcasts.cancelled_email.member_lookup_failed',
    );
    return;
  }
  if (memberEmail === null) {
    logger.warn(
      {
        tenantId: args.tenant.slug,
        broadcastId: args.broadcast.broadcastId as string,
      },
      'broadcasts.cancelled_email.skipped_no_primary_contact',
    );
    return;
  }
  try {
    await args.emailTransactional.sendMemberEmail(
      args.tenant,
      {
        to: memberEmail,
        subject: args.broadcast.subject,
        templateKey: 'broadcast_cancelled',
        payload: {
          broadcastId: args.broadcast.broadcastId,
          broadcastSubject: args.broadcast.subject,
          memberDisplayName: args.broadcast.fromName,
          cancellationReason: args.cancellationReason,
        },
        locale: 'en',
      },
      args.tx,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenant.slug,
        broadcastId: args.broadcast.broadcastId as string,
      },
      'broadcasts.cancelled_email.enqueue_failed',
    );
  }
}
