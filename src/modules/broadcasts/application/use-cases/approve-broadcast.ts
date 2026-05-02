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
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { enqueueBroadcastMemberNotification } from '../enqueue-member-notification';
// Verify-fix R4 (Types-#1, 2026-05-02): re-export canonical `Locale`
// from `@/i18n/config` instead of duplicating the union literal in
// every use-case file. Single source of truth; adding a 4th locale
// (e.g. `de`) now requires touching ONE file.
import type { Locale } from '@/i18n/config';
export type NotificationLocale = Locale;

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
   * G2 closure (verify-fix 2026-05-02 — US2 wire-up) —
   * `EmailTransactionalPort` for enqueuing the post-approval member
   * notification (templateKey `broadcast_approved` →
   * notification_type `broadcast_approved_notification`). Best-effort:
   * failures are logged but do NOT block the transition + audit.
   * Optional so legacy unit tests that omit notification scope still
   * compile; production composition root always supplies it.
   */
  readonly emailTransactional?: EmailTransactionalPort;
  /**
   * Verify-fix R4 (Types-#6, 2026-05-02) — used to resolve member's
   * preferred locale (`getMemberPreferredLocale`); falls back to
   * `notificationLocale` input → `'en'` if both null. Optional for
   * test back-compat.
   */
  readonly membersBridge?: MembersBridgePort;
}

export interface ApproveBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly decision: ApproveDecision;
  readonly requestId: string | null;
  /**
   * E1 closure (verify-fix 2026-05-02) — locale for the post-approval
   * member notification email. Route resolves from admin session OR
   * tenant default. Optional for back-compat with legacy callers.
   */
  readonly notificationLocale?: NotificationLocale;
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
          'submitted', // R4 Types-#5 — race-guard against concurrent action
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
      // status transition + audit. Single enqueue site (use-case)
      // prevents the double-send footgun where both the route + the
      // use-case might enqueue. Routes pass `notificationLocale`;
      // missing → 'en' fallback.
      //
      // Recipient = `replyToEmail` (immutable submit-time snapshot per
      // FR-002 precondition j) NOT current `members.primary_contact_email`
      // — preserves the "the email goes to whoever submitted, even if
      // they later changed their primary contact" semantics.
      //
      // Verify-fix R4 (Simplify-#2): uses shared
      // `enqueueBroadcastMemberNotification` helper (was 3 near-
      // identical helpers across approve/reject/cancel; now one).
      // Verify-fix R4 (Types-#6): locale resolution priority chain
      // `memberPreferred ?? notificationLocale (route default) ?? 'en'`.
      // Best-effort lookup — bridge throw → falls through to next.
      if (deps.emailTransactional) {
        let memberPreferred: 'en' | 'th' | 'sv' | null = null;
        if (deps.membersBridge) {
          try {
            memberPreferred = await deps.membersBridge.getMemberPreferredLocale(
              deps.tenant,
              approved.requestedByMemberId,
            );
          } catch {
            // Best-effort — fall through to tenant default
          }
        }
        await enqueueBroadcastMemberNotification({
          tenant: deps.tenant,
          emailTransactional: deps.emailTransactional,
          broadcast: approved,
          variant: {
            templateKey: 'broadcast_approved',
            scheduledForIso: scheduledFor.toISOString(),
          },
          locale: memberPreferred ?? input.notificationLocale ?? 'en',
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

// Verify-fix R4 (Simplify-#2, 2026-05-02): local enqueueApprovedNotification
// helper removed — replaced by shared `enqueueBroadcastMemberNotification`
// in `../enqueue-member-notification.ts`.
