/**
 * T101 — `reject-broadcast.ts` Application use-case (F7 US2).
 *
 * FR-012: rejection requires non-empty reason. Reason flow:
 *   - VERBATIM to member email (notification context_data)
 *   - sha256 hash to audit log (NOT raw)
 *
 * State-check: status must be `submitted` (rejected from any other
 * state with `broadcast_invalid_state_transition`).
 *
 * Atomic: applyTransition('rejected') + audit emit + member-notification
 * outbox enqueue inside single tx; failure rolls all back.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';

export type NotificationLocale = 'en' | 'th' | 'sv';

const MIN_REASON_LENGTH = 1;
const MAX_REASON_LENGTH = 2000;

export type RejectBroadcastError =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'broadcast_invalid_state_transition';
      readonly observedStatus: string;
    }
  | {
      readonly kind: 'broadcast_concurrent_action_blocked';
      readonly observedStatus: string;
    }
  | { readonly kind: 'broadcast_rejection_reason_required' }
  | {
      readonly kind: 'broadcast_rejection_reason_too_long';
      readonly length: number;
    }
  | { readonly kind: 'reject.server_error'; readonly message: string };

export interface RejectBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
  readonly clock: { now(): Date };
  /** G2 closure (verify-fix 2026-05-02) — best-effort post-rejection email. */
  readonly emailTransactional?: EmailTransactionalPort;
}

export interface RejectBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly rejectionReason: string;
  readonly requestId: string | null;
  /** E1 closure (verify-fix 2026-05-02) — locale for notification email. */
  readonly notificationLocale?: NotificationLocale;
}

export interface RejectBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly reservationReleased: true;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function rejectBroadcast(
  deps: RejectBroadcastDeps,
  input: RejectBroadcastInput,
): Promise<Result<RejectBroadcastOutput, RejectBroadcastError>> {
  const trimmed = input.rejectionReason.trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    return err({ kind: 'broadcast_rejection_reason_required' });
  }
  if (input.rejectionReason.length > MAX_REASON_LENGTH) {
    return err({
      kind: 'broadcast_rejection_reason_too_long',
      length: input.rejectionReason.length,
    });
  }

  const now = deps.clock.now();
  const reasonHash = sha256Hex(input.rejectionReason);

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

      let rejected: Broadcast;
      try {
        rejected = await deps.broadcastsRepo.applyTransition(
          tx,
          deps.tenant.slug,
          input.broadcastId,
          'rejected',
          {
            rejectedAt: now,
            rejectedByUserId: input.actorUserId,
            rejectionReason: input.rejectionReason,
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

      // Audit — sha256 hash only, NOT raw reason (FR-012)
      await deps.audit.emit(tx, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_rejected',
        actorUserId: input.actorUserId,
        summary: `Broadcast ${input.broadcastId} rejected`,
        payload: {
          broadcastId: input.broadcastId,
          rejectedByUserId: input.actorUserId,
          rejectionReasonHash: reasonHash,
          rejectionReasonLength: input.rejectionReason.length,
          rejectedAt: now.toISOString(),
        },
        requestId: input.requestId,
      });

      // G2 closure (verify-fix 2026-05-02) — VERBATIM rejection reason
      // travels in the email payload (FR-012). Audit retains hash only.
      // Recipient = `replyToEmail` (immutable submit-time snapshot).
      if (deps.emailTransactional && rejected.replyToEmail.length > 0) {
        await enqueueRejectedNotification({
          tenant: deps.tenant,
          emailTransactional: deps.emailTransactional,
          broadcast: rejected,
          rejectionReason: input.rejectionReason,
          locale: input.notificationLocale ?? 'en',
          tx,
        });
      }

      return ok({
        broadcast: rejected,
        reservationReleased: true as const,
      });
    });
  } catch (e) {
    return err({
      kind: 'reject.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

async function enqueueRejectedNotification(args: {
  readonly tenant: TenantContext;
  readonly emailTransactional: EmailTransactionalPort;
  readonly broadcast: Broadcast;
  readonly rejectionReason: string;
  readonly locale: NotificationLocale;
  readonly tx: unknown;
}): Promise<void> {
  try {
    await args.emailTransactional.sendMemberEmail(
      args.tenant,
      {
        to: args.broadcast.replyToEmail,
        subject: args.broadcast.subject,
        templateKey: 'broadcast_rejected',
        payload: {
          broadcastId: args.broadcast.broadcastId,
          broadcastSubject: args.broadcast.subject,
          memberDisplayName: args.broadcast.fromName,
          rejectionReason: args.rejectionReason,
        },
        locale: args.locale,
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
      'broadcasts.rejected_email.enqueue_failed',
    );
  }
}
