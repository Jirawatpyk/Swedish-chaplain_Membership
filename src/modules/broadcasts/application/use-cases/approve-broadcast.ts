/**
 * T100 — `approve-broadcast.ts` Application use-case (F7 US2).
 *
 * Two paths via `decision` discriminator:
 *   - 'send_now':  applyTransition(approved) with scheduledFor=now()
 *                  → cron picks up within 60s + flips to 'sending'
 *   - 'schedule':  applyTransition(approved) with scheduledFor=<future>
 *                  → cron picks up at scheduledFor
 *
 * NOT done in this use-case (per Ultraplan AD1 — F4 issue-invoice
 * pattern):
 *   - Resend Broadcasts API call (deferred to dispatch cron)
 *   - status='sending' transition (cron worker owns it)
 *
 * State-check: status must be `submitted`.
 * Schedule defence: scheduledFor must be ≥ now+5min (Ultraplan AD8).
 *
 * Atomic: applyTransition('approved') + audit `broadcast_approved` +
 * member-notification outbox enqueue inside single tx.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';

const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

export type ApproveDecision =
  | { readonly mode: 'send_now' }
  | { readonly mode: 'schedule'; readonly scheduledFor: Date };

export type ApproveBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'broadcast_invalid_state_transition';
      readonly observedStatus: string;
    }
  | {
      readonly kind: 'broadcast_concurrent_action_blocked';
      readonly observedStatus: string;
    }
  | { readonly kind: 'broadcast_schedule_too_soon'; readonly scheduledFor: Date }
  | { readonly kind: 'approve.server_error'; readonly message: string };

export interface ApproveBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
  /**
   * G2 closure (verify-fix 2026-05-02 — US2 wire-up) — used to look
   * up the originating member's primary contact email + display name
   * for the post-approval member notification. Optional: when omitted,
   * the email enqueue is skipped (used by tests + legacy callers).
   */
  readonly membersBridge?: MembersBridgePort;
  /**
   * G2 closure — `EmailTransactionalPort` for enqueuing the
   * post-approval member notification (templateKey
   * `broadcast_approved` → notification_type
   * `broadcast_approved_notification`). Best-effort: failures are
   * logged but do NOT block the transition + audit.
   */
  readonly emailTransactional?: EmailTransactionalPort;
}

export interface ApproveBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly decision: ApproveDecision;
  readonly requestId: string | null;
}

export interface ApproveBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly status: 'approved';
  readonly approvedAt: Date;
  readonly scheduledFor: Date;
}

export async function approveBroadcast(
  deps: ApproveBroadcastDeps,
  input: ApproveBroadcastInput,
): Promise<Result<ApproveBroadcastOutput, ApproveBroadcastError>> {
  const now = deps.clock.now();

  // Schedule defence — server-side validation mirrors zod refine on route
  if (input.decision.mode === 'schedule') {
    const minAllowed = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MS);
    if (input.decision.scheduledFor.getTime() < minAllowed.getTime()) {
      return err({
        kind: 'broadcast_schedule_too_soon',
        scheduledFor: input.decision.scheduledFor,
      });
    }
  }

  const scheduledFor =
    input.decision.mode === 'send_now' ? now : input.decision.scheduledFor;

  try {
    return await deps.broadcastsRepo.withTx(async (tx) => {
      const lockedStatus = await deps.broadcastsRepo.lockForUpdate(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      if (lockedStatus === null) {
        return err({
          kind: 'broadcast_not_found',
          broadcastId: input.broadcastId as string,
        });
      }
      if (lockedStatus !== 'submitted') {
        return err({
          kind: 'broadcast_invalid_state_transition',
          observedStatus: lockedStatus,
        });
      }

      let approved: Broadcast;
      try {
        approved = await deps.broadcastsRepo.applyTransition(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          'approved',
          {
            approvedAt: now,
            approvedByUserId: input.actorUserId,
            scheduledFor,
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
        eventType: 'broadcast_approved',
        actorUserId: input.actorUserId,
        summary: `Broadcast ${input.broadcastId} approved (${input.decision.mode})`,
        payload: {
          broadcastId: input.broadcastId,
          approvedByUserId: input.actorUserId,
          decision: input.decision.mode,
          scheduledFor: scheduledFor.toISOString(),
          approvedAt: now.toISOString(),
        },
        requestId: input.requestId,
      });

      // G2 closure (verify-fix 2026-05-02 — US2 wire-up) — enqueue the
      // post-approval member notification email IN-TX so the
      // notifications_outbox INSERT commits atomically with the
      // status transition + audit. Best-effort: lookup or enqueue
      // failures are logged but do NOT roll back the transition.
      if (deps.emailTransactional && deps.membersBridge) {
        await enqueueApprovedNotification({
          tenant: deps.tenant,
          membersBridge: deps.membersBridge,
          emailTransactional: deps.emailTransactional,
          broadcast: approved,
          scheduledFor,
          tx,
        });
      }

      return ok({
        broadcast: approved,
        status: 'approved' as const,
        approvedAt: now,
        scheduledFor,
      });
    });
  } catch (e) {
    return err({
      kind: 'approve.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

/**
 * G2 closure helper — enqueue the post-approval member notification.
 * Best-effort: failures are logged + swallowed (mirrors the dispatch
 * use-case's `enqueueDispatchFailureNotification`).
 */
async function enqueueApprovedNotification(args: {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly emailTransactional: EmailTransactionalPort;
  readonly broadcast: Broadcast;
  readonly scheduledFor: Date;
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
      'broadcasts.approved_email.member_lookup_failed',
    );
    return;
  }
  if (memberEmail === null) {
    logger.warn(
      {
        tenantId: args.tenant.slug,
        broadcastId: args.broadcast.broadcastId as string,
      },
      'broadcasts.approved_email.skipped_no_primary_contact',
    );
    return;
  }
  try {
    await args.emailTransactional.sendMemberEmail(
      args.tenant,
      {
        to: memberEmail,
        subject: args.broadcast.subject,
        templateKey: 'broadcast_approved',
        payload: {
          broadcastId: args.broadcast.broadcastId,
          broadcastSubject: args.broadcast.subject,
          memberDisplayName: args.broadcast.fromName,
          scheduledForIso: args.scheduledFor.toISOString(),
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
      'broadcasts.approved_email.enqueue_failed',
    );
  }
}
