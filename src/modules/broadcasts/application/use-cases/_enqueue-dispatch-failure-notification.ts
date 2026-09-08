/**
 * FR-021 / AS2 — tell the member their broadcast did not go out.
 *
 * Extracted from `dispatch-scheduled-broadcast.ts` in 108 Phase 9. It lived
 * inside that 1,200-line module and required its whole `Deps`, which is why
 * `buildAudienceTick` could not call it and shipped with NO member
 * notification: a member whose broadcast died learned nothing, while
 * `docs/runbooks/broadcast-audience-build.md` § C.4 stated they were told.
 *
 * Moved rather than imported across because `build-audience-tick.ts` exists on
 * the premise that neither dispatch path knows the other is there. A shared
 * helper in its own file keeps that true; importing the legacy use case would
 * not.
 */
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';

/**
 * Slice E (Phase 8) — enqueue the FR-021 / AS2 transactional
 * notification email informing the originating member that their
 * scheduled broadcast did not go out. Quota reservation is preserved;
 * member can re-schedule from the admin queue.
 *
 * Best-effort: member-lookup failures + missing primary contact are
 * logged but skipped (NOT thrown). The terminal-fail transition + audit
 * are already committed by the time this runs. Mirrors the US5
 * `enqueueDeliverySummaryEmail` graceful-degrade pattern.
 */
/**
 * Exactly what the FR-021 / AS2 notification needs — no more.
 *
 * It used to require the whole `DispatchScheduledBroadcastDeps`, which is why
 * `buildAudienceTick` could not call it and shipped with no member notification
 * at all: a member whose broadcast died had no way to learn that, and the
 * runbook claimed otherwise. `DispatchScheduledBroadcastDeps` still satisfies
 * this structurally, so the legacy caller is unchanged.
 *
 * The review's sharpest finding was the mirror image of this — a port narrowed
 * to "what this use case reads" silently discarded a field a previous round had
 * added. Narrowing a REQUIREMENT widens who can meet it; narrowing a RETURN
 * shape deletes information. Worth keeping the two apart.
 */
export interface DispatchFailureNotificationDeps {
  readonly tenant: TenantContext;
  readonly membersBridge: MembersBridgePort;
  readonly emailTransactional: EmailTransactionalPort;
  readonly audit: AuditPort;
  readonly tenantDisplayName: string;
  readonly locale: 'en' | 'th' | 'sv';
}

export async function enqueueDispatchFailureNotification(args: {
  readonly deps: DispatchFailureNotificationDeps;
  readonly broadcast: Broadcast;
  readonly reason: string;
  readonly now: Date;
}): Promise<void> {
  const { deps, broadcast, reason, now } = args;

  let memberEmail: string | null;
  try {
    memberEmail = await deps.membersBridge.getMemberPrimaryContact(
      deps.tenant,
      broadcast.requestedByMemberId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch_failure_email.member_lookup_failed',
    );
    return;
  }

  if (memberEmail === null) {
    logger.warn(
      {
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch_failure_email.skipped_no_primary_contact',
    );
    // Verify-fix R3 (Errors-H3, 2026-05-02): emit durable audit event
    // for the missed AS2 notification so compliance review has a
    // greppable trail. Pino logs roll out of retention long before
    // any audit. Best-effort — failure to emit audit also logs but
    // does NOT throw (mirrors the rest of dispatch use-case best-
    // effort guards).
    try {
      await deps.audit.emit(null, {
        tenantId: deps.tenant.slug,
        eventType: 'broadcast_dispatch_failure_notif_skipped_no_email',
        actorUserId: 'system:cron',
        summary: `AS2 dispatch-failure notification skipped — member ${broadcast.requestedByMemberId} has no primary contact email`,
        payload: {
          broadcastId: broadcast.broadcastId,
          memberId: broadcast.requestedByMemberId,
          reason,
          failedAt: now.toISOString(),
        },
        requestId: null,
      });
    } catch (auditErr) {
      logger.error(
        {
          err: auditErr instanceof Error ? auditErr.message : String(auditErr),
          tenantId: deps.tenant.slug,
          broadcastId: broadcast.broadcastId as string,
        },
        'broadcasts.dispatch_failure_email.skipped_audit_emit_failed',
      );
    }
    return;
  }

  // Email-locale audit 2026-07-16 — render the failure notice in the member's
  // language (was tenant-default only). Priority: member preferred → tenant
  // default (deps.locale) → 'en'. Best-effort — a bridge throw falls through.
  let memberPreferred: 'en' | 'th' | 'sv' | null = null;
  try {
    memberPreferred = await deps.membersBridge.getMemberPreferredLocale(
      deps.tenant,
      broadcast.requestedByMemberId,
    );
  } catch (localeErr) {
    logger.warn(
      {
        err: localeErr instanceof Error ? localeErr.message : String(localeErr),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch_failure_email.locale_resolve_failed',
    );
  }

  try {
    await deps.emailTransactional.sendMemberEmail(
      deps.tenant,
      {
        to: memberEmail,
        subject: broadcast.subject,
        templateKey: 'broadcast_failed_to_dispatch',
        payload: {
          broadcastId: broadcast.broadcastId,
          broadcastSubject: broadcast.subject,
          tenantDisplayName: deps.tenantDisplayName,
          scheduledFor:
            broadcast.scheduledFor !== null
              ? broadcast.scheduledFor.toISOString()
              : now.toISOString(),
          reason,
        },
        locale: memberPreferred ?? deps.locale,
      },
      null,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
      },
      'broadcasts.dispatch_failure_email.enqueue_failed',
    );
  }
}
