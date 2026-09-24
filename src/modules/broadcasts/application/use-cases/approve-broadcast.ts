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
 * Send-time standing (F119 T166 S-H1): the owning member must not be halted
 * and must hold full F8 membership access — the rules submit applies, re-read
 * just BEFORE the row-lock tx (the bridges take their own pool connections)
 * and applied under the lock (`member_halted` / `member_not_in_good_standing`,
 * 409).
 * Each refusal writes submit's own refusal audit row (T166 follow-up) on the
 * approval's tx — a `return err()` inside it commits, and nothing else was
 * written, so the row lands under the tenant GUC with no null-tx question.
 * Schedule defence: scheduledFor must be ≥ now+5min (Ultraplan AD8).
 *
 * Atomic: applyTransition('approved') + audit `broadcast_approved` +
 * member-notification outbox enqueue inside single tx.
 */
import { err, ok, type Result } from '@/lib/result';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import { BroadcastConcurrentMutationError, type BroadcastsRepo } from '../ports/broadcasts-repo';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import { enqueueBroadcastMemberNotification } from '../enqueue-member-notification';
import {
  readMemberSendStanding,
  standingRefusalAuditEvent,
  type MemberSendStandingDeps,
} from './_member-send-standing';
// Verify-fix R4 (Types-#1, 2026-05-02): re-export canonical `Locale`
// from `@/i18n/config` instead of duplicating the union literal in
// every use-case file. Single source of truth; adding a 4th locale
// (e.g. `de`) now requires touching ONE file.
import type { Locale } from '@/i18n/config';
export type NotificationLocale = Locale;

/** The `now + 5 min` schedule floor — shared with F119 `confirmSchedule` (T060). */
export const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

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
  /** F119 T166 S-H1 — the owning member's broadcasts are halted pending admin review. */
  | { readonly kind: 'member_halted'; readonly memberId: string }
  /** F119 T166 S-H1 — the owning member's membership is suspended or terminated (F8). */
  | { readonly kind: 'member_not_in_good_standing'; readonly memberId: string }
  /**
   * An infrastructure fault. `errKind` is the error CLASS only (T166 follow-up,
   * the R-M4 class): the raw message can carry a Neon error's bound
   * parameters, and the route logs what it is handed.
   */
  | { readonly kind: 'approve.server_error'; readonly errKind: string };

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
  /**
   * F119 T166 S-H1 — the send-time rules submit applies (halt flag + F8
   * membership access), re-read before the approval. REQUIRED: a security
   * gate is never optional in the composition.
   */
  readonly sendStanding: MemberSendStandingDeps;
}

export interface ApproveBroadcastInput {
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  /**
   * T166 follow-up — the session role, recorded as held (`?? null`, never a
   * literal stand-in) on a standing-refusal audit row.
   */
  readonly actorRole: string | null;
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
    // F119 T166 follow-up — the halt / access reads go through the members
    // bridges, each on its OWN pool connection, so they are made BEFORE the
    // tx, never while it holds the row lock (the R-L3 class: ~10 concurrent
    // approvals would starve the pool). `requested_by_member_id` is immutable
    // after submit, so a non-locking pre-read of the row names the member the
    // locked row will; a missing row falls through to the not-found handling
    // below. Only a `submitted` row can be approved, so only it is read for.
    const preRead = await deps.broadcastsRepo.findById(deps.tenant.slug, input.broadcastId);
    const standing =
      preRead?.status === 'submitted'
        ? await readMemberSendStanding(deps.sendStanding, deps.tenant, preRead.requestedByMemberId)
        : null;

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

      // F119 T166 S-H1 — approving makes the row dispatchable, so the owning
      // member's halt flag and F8 membership access (read just before this tx,
      // exactly as submit reads them) are applied here, once the lock confirms
      // the row is still `submitted`. This is the LAST check on this path:
      // dispatch does not re-check standing (quickstart § 3.6). Refusals
      // return BEFORE any write (a `return err()` inside the tx commits
      // nothing written so far).
      const row = await deps.broadcastsRepo.findByIdInTx(
        tx,
        deps.tenant.slug,
        input.broadcastId,
      );
      if (row === null) {
        return err({
          kind: 'broadcast_not_found',
          broadcastId: input.broadcastId as string,
        });
      }
      // The row reached `submitted` between the pre-read and the lock, so no
      // standing was read for it: fail CLOSED rather than approve unchecked.
      if (standing === null) throw new Error('member send standing not read before the lock');
      switch (standing.kind) {
        case 'halted':
        case 'not_in_good_standing': {
          const refusal = standingRefusalAuditEvent({
            refusal: standing.kind,
            surface: 'approve_as_submitted',
            tenantSlug: deps.tenant.slug,
            memberId: row.requestedByMemberId,
            broadcastId: input.broadcastId as string,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            requestId: input.requestId,
          });
          await deps.audit.emit(tx, refusal);
          broadcastsMetrics.auditEmitCount(deps.tenant.slug, refusal.eventType);
          return err({
            kind: standing.kind === 'halted' ? 'member_halted' : 'member_not_in_good_standing',
            memberId: row.requestedByMemberId,
          });
        }
        case 'halt_read_failed':
        case 'access_unavailable':
          // Fail CLOSED: the gate was not decided → approve.server_error.
          throw new Error(`member send standing unavailable: ${standing.kind}`);
        case 'ok':
          break;
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
      } catch (e) {
        // R7 staff-review HIGH-1 fix — narrow catch to the concurrency
        // sentinel only. Mirrors W-R2 fix in cancel-broadcast.ts. The
        // prior bare `catch` swallowed any throw including Neon
        // outages on the refresh query, surfacing as
        // `broadcast_concurrent_action_blocked` with `status='unknown'`
        // — wrong HTTP code (409 vs 500), wrong metric counter,
        // misleading on-call signal.
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
      // T172 — emit-site wiring (Phase 9). Volume counter on the
      // approved-events stream; SLO-F7-004 latency histogram emitted
      // by the route wrapper around this use-case.
      broadcastsMetrics.auditEmitCount(deps.tenant.slug, 'broadcast_approved');

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
          } catch (e) {
            // R5 verify-fix Errors-H3 (2026-05-02): log before swallow
            // so a degraded membersBridge produces a forensic trail
            // (was empty catch, locale downgrade was invisible).
            logger.warn(
              {
                err: errKind(e),
                tenantId: deps.tenant.slug,
                memberId: approved.requestedByMemberId,
                useCase: 'approve-broadcast',
              },
              'broadcasts.locale_resolve_failed',
            );
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
    return err({ kind: 'approve.server_error', errKind: errKind(e) });
  }
}

// Verify-fix R4 (Simplify-#2, 2026-05-02): local enqueueApprovedNotification
// helper removed — replaced by shared `enqueueBroadcastMemberNotification`
// in `../enqueue-member-notification.ts`.
