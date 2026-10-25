/**
 * Archive / restore cascades shared by the single use cases
 * (`archiveMember`, `undeleteMember`) and the bulk `archive` / `unarchive`
 * arms (126 #2). Before 126 only the single paths ran them: a bulk-archived
 * member's portal users stayed signed in and its renewal cycle kept running.
 *
 *   - `revokeMemberAccessInTx` — IN the caller's tx: revoke every linked
 *     user's sessions (+ one `user_sessions_revoked` audit each) and
 *     soft-consume their pending invitations.
 *   - `runPostArchiveCascades` — AFTER the archive commits: cancel the
 *     member's in-flight broadcasts and renewal cycle. Best-effort.
 *   - `runRenewalsRestoreCascade` — AFTER an undelete commits: re-create one
 *     active renewal cycle. Best-effort.
 */
import type { TenantTx } from '@/lib/db';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics, renewalsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastsCascadePort } from '../ports/broadcasts-cascade-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { InvitationCascadePort } from '../ports/invitation-cascade-port';
import type { RenewalsCascadePort } from '../ports/renewals-cascade-port';
import type { SessionRevocationPort } from '../ports/session-revocation-port';

export type CascadeMeta = {
  actorUserId: string;
  requestId: string;
};

export type MemberAccessCascadeDeps = {
  tenant: TenantContext;
  contactRepo: Pick<ContactRepo, 'listLinkedUserIdsForMemberInTx'>;
  sessions: SessionRevocationPort;
  invitations: InvitationCascadePort;
  audit: AuditPort;
};

export type MemberAccessCascadeResult = {
  cascadedUserIds: string[];
  sessionsRevokedTotal: number;
  invitationsRevokedCount: number;
};

export async function revokeMemberAccessInTx(
  tx: TenantTx,
  memberId: MemberId,
  now: Date,
  meta: CascadeMeta,
  deps: MemberAccessCascadeDeps,
): Promise<MemberAccessCascadeResult> {
  // Cascade — read linked users inside the same tx snapshot so we
  // revoke exactly the sessions of the users linked at archive time.
  // Principle III: via ContactRepo port, not a raw schema select.
  const linkedUserIds = await deps.contactRepo.listLinkedUserIdsForMemberInTx(
    tx,
    memberId,
  );

  // R002 (staff-review-20260417-us7) — dedupe linkedUserIds before
  // revocation: if the same F1 user is linked to multiple contacts
  // on this member (rare — one person holding two role titles),
  // iterating the raw list would emit duplicate `user_sessions_revoked`
  // audits (first call revokes N, subsequent calls revoke 0 but still
  // emit). Set-dedupe keeps exactly one audit per user.
  const uniqueLinkedUserIds = Array.from(new Set(linkedUserIds));

  let sessionsRevokedTotal = 0;
  for (const userId of uniqueLinkedUserIds) {
    const revoked = await deps.sessions.revokeAllForInTx(
      tx,
      userId,
      'admin_force',
    );
    if (!revoked.ok) {
      throw new Error(`session_revoke_failed:${revoked.error.code}`);
    }
    sessionsRevokedTotal += revoked.value.revokedCount;

    const sessionAudit = await deps.audit.recordInTx(tx, deps.tenant, {
      type: 'user_sessions_revoked',
      actorUserId: meta.actorUserId,
      requestId: meta.requestId,
      summary: `sessions revoked for user ${userId} — member archived`,
      payload: {
        user_id: userId,
        member_id: memberId,
        revoked_count: revoked.value.revokedCount,
        reason: 'admin_force_archive',
      },
    });
    if (!sessionAudit.ok) throw new Error('audit_failed');
  }

  // Soft-consume any pending/unredeemed invitations for the linked
  // users so the invite links become dead — defense-in-depth per
  // spec Edge Cases. Cross-module boundary handled via
  // InvitationCascadePort (Principle III). R001 column-grant
  // semantics preserved inside the adapter (`returning({ userId })`
  // only — never exposes `invitations.id`).
  const { revokedCount: invitationsRevokedCount } =
    await deps.invitations.softConsumePendingForUsersInTx(
      tx,
      uniqueLinkedUserIds,
      now,
    );

  return {
    cascadedUserIds: uniqueLinkedUserIds,
    sessionsRevokedTotal,
    invitationsRevokedCount,
  };
}

export type PostArchiveCascadeDeps = {
  tenant: TenantContext;
  broadcastsCascade: BroadcastsCascadePort;
  renewalsCascade: RenewalsCascadePort;
};

export async function runPostArchiveCascades(
  memberId: MemberId,
  meta: CascadeMeta,
  deps: PostArchiveCascadeDeps,
): Promise<void> {
  // F7 in-flight broadcasts cascade (T178a / Coverage Gap C2 / T199 H-1).
  // Runs AFTER the F3 archival tx commits — the cascade opens its own
  // short tx per broadcast (independent row-locks; concurrent races
  // on individual broadcasts do not roll back the whole F3 archive).
  // Failure here is non-fatal: the adapter logs + returns zero so the
  // member archive remains successful even if a transient F7 issue
  // leaves a broadcast in-flight. Ops can re-run cleanup manually.
  {
    try {
      const cascadeResult =
        await deps.broadcastsCascade.cancelInFlightForMember(
          deps.tenant,
          memberId,
          {
            cancellationReason: 'originator_member_deleted',
            initiatedByUserId: meta.actorUserId,
            requestId: meta.requestId,
          },
        );
      if (cascadeResult.outcome === 'cascade_failed') {
        // Adapter already logged the underlying error. Emit
        // stop-the-line metric so dashboards distinguish this from
        // the no-in-flight + ok case (both report cancelledCount=0).
        broadcastsMetrics.cascadeOutcome(
          deps.tenant.slug,
          'unexpected_error',
        );
      } else if (cascadeResult.outcome === 'cascade_partial_failure') {
        // Round 5 review fix — partial cascade is now a first-class
        // signal at the port level. The per-broadcast
        // `unexpected_error` metric was already emitted inside the
        // F7 use-case loop (so dashboards alert), but until now the
        // F3 caller had no visibility — the cleanup runbook had to
        // diff cascadeOutcome metric against archive-member call
        // count. Now we record a structured log keyed by `memberId`
        // so ops can grep which member's archive ended in partial
        // cascade and re-attempt cancellation for the stuck rows.
        logger.error(
          {
            tenantId: deps.tenant.slug,
            memberId,
            requestId: meta.requestId,
            cancelledCount: cascadeResult.cancelledCount,
            skippedConcurrentCount: cascadeResult.skippedConcurrentCount,
            unexpectedErrorCount: cascadeResult.unexpectedErrorCount,
            cascade: 'f7_in_flight_broadcast_cancel',
          },
          'archive-member: broadcasts cascade partial — some broadcasts remain in flight',
        );
      }
    } catch (cascadeErr) {
      // Adapter is supposed to translate failures to
      // `outcome: 'cascade_failed'`; a throw here means the adapter
      // itself blew up (e.g. composition root mis-wired). Treat as
      // unexpected-error: emit metric + structured log; member archive
      // still committed and remains successful.
      broadcastsMetrics.cascadeOutcome(
        deps.tenant.slug,
        'unexpected_error',
      );
      logger.error(
        {
          err: errKind(cascadeErr),
          // Round 2 silent-failure LOW — surface error class so the
          // alert runbook can distinguish a TypeError (programmer
          // mis-wire) from a network/IO blip in the same metric
          // bucket.
          errName:
            cascadeErr instanceof Error ? cascadeErr.name : undefined,
          memberId,
          requestId: meta.requestId,
          cascade: 'f7_in_flight_broadcast_cancel',
        },
        'archive-member: broadcasts cascade threw — member archive succeeded',
      );
    }
  }

  // F8 in-flight renewal-cycles cascade (Phase 9 / T239). Mirrors
  // the F7 broadcasts-cascade contract above — runs AFTER the F3
  // archival tx commits, opens its own short tx per cycle, and is
  // non-fatal for F3 archival (a transient F8 issue must not block
  // the member archive). Reuses `renewal_cycle_cancelled` audit
  // event with `payload.reason='originator_member_archived'` so
  // forensic dashboards can distinguish system-initiated cascade
  // from admin manual cancel.
  {
    try {
      const cascadeResult =
        await deps.renewalsCascade.cancelInFlightForMember(
          deps.tenant,
          memberId,
          {
            cancellationReason: 'originator_member_deleted',
            initiatedByUserId: meta.actorUserId,
            requestId: meta.requestId,
          },
        );
      if (cascadeResult.outcome === 'cascade_failed') {
        // Adapter already logged the underlying error. F3 archival
        // remains successful; ops can re-run cleanup manually.
        // Phase 9 verify-fix — emit cascadeOutcome metric so the
        // audit-emit-loss runbook can alert on F8 cascade health
        // (mirrors the F7 broadcastsMetrics.cascadeOutcome pattern).
        renewalsMetrics.cascadeOutcome(
          deps.tenant.slug,
          'unexpected_error',
        );
        logger.error(
          {
            tenantId: deps.tenant.slug,
            memberId,
            requestId: meta.requestId,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'archive-member: renewals cascade failed — cycle may remain in-flight',
        );
      } else if (cascadeResult.outcome === 'cascade_partial_failure') {
        // Concurrent admin cancel won the race for the cycle — log
        // partial outcome so ops can verify the cycle landed in
        // `cancelled` (admin-initiated, not cascade-initiated).
        // Phase 9 verify-fix — emit cascadeOutcome with concurrent_skip
        // kind so the dashboard distinguishes race from real failure.
        renewalsMetrics.cascadeOutcome(
          deps.tenant.slug,
          'concurrent_skip',
        );
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            memberId,
            requestId: meta.requestId,
            cancelledCount: cascadeResult.cancelledCount,
            skippedConcurrentCount: cascadeResult.skippedConcurrentCount,
            cascade: 'f8_in_flight_cycle_cancel',
          },
          'archive-member: renewals cascade partial — concurrent admin cancel won race',
        );
      } else if (cascadeResult.outcome === 'ok') {
        // Phase 9 verify-fix — emit cascadeOutcome on the happy
        // path too so the dashboard tracks normal cascade volume,
        // not just incidents.
        renewalsMetrics.cascadeOutcome(deps.tenant.slug, 'cancelled');
      }
    } catch (cascadeErr) {
      // Phase 9 verify-fix — emit cascadeOutcome on the outer-catch
      // throw path. The adapter is supposed to translate use-case
      // failures into typed `cascade_failed` outcomes; reaching this
      // catch implies the adapter ITSELF blew up (composition root
      // mis-wire), which is a stop-the-line incident class distinct
      // from the typed cascade_failed path.
      renewalsMetrics.cascadeOutcome(
        deps.tenant.slug,
        'unexpected_error',
      );
      logger.error(
        {
          err: errKind(cascadeErr),
          errName:
            cascadeErr instanceof Error ? cascadeErr.name : undefined,
          memberId,
          requestId: meta.requestId,
          cascade: 'f8_in_flight_cycle_cancel',
        },
        'archive-member: renewals cascade threw — member archive succeeded',
      );
    }
  }
}

export async function runRenewalsRestoreCascade(
  memberId: MemberId,
  meta: CascadeMeta,
  deps: { tenant: TenantContext; renewalsCascade: RenewalsCascadePort },
): Promise<void> {
  // Cluster 4 (2026-07-12) — F8 renewal-cycle RESTORE cascade. Runs AFTER
  // the F3 undelete tx commits (mirrors archive-member's cancel cascade):
  // opens its own tx to idempotently re-create ONE active cycle anchored at
  // the member's PAID-THROUGH frontier (so it never overlaps an already-paid
  // period → double-bill; review-fix), so the restored member re-appears in
  // the renewal pipeline. Best-effort: a failure logs + emits a metric but
  // does NOT fail the undelete (the member row is already restored durably;
  // ops can re-attempt via admin "renew" if the cycle restore failed — e.g.
  // the member's plan is no longer offered).
  {
    try {
      const restore = await deps.renewalsCascade.restoreForMember(
        deps.tenant,
        memberId,
        {
          initiatedByUserId: meta.actorUserId,
          requestId: meta.requestId,
        },
      );
      renewalsMetrics.restoreOutcome(deps.tenant.slug, restore.outcome);
      if (restore.outcome === 'restore_failed') {
        // The member is restored but has NO active cycle — a "member
        // silently dropped from the renewal pipeline" state. Structured
        // log keyed by memberId so ops can grep + re-attempt (admin renew).
        logger.error(
          {
            tenantId: deps.tenant.slug,
            memberId,
            requestId: meta.requestId,
            cascade: 'f8_undelete_cycle_restore',
          },
          'undelete-member: renewals restore failed — member restored WITHOUT an active cycle (re-attempt via admin renew)',
        );
      } else if (restore.outcome === 'skipped_member_absent') {
        logger.warn(
          {
            tenantId: deps.tenant.slug,
            memberId,
            requestId: meta.requestId,
            cascade: 'f8_undelete_cycle_restore',
          },
          'undelete-member: renewals restore skipped — member unreadable post-commit',
        );
      }
    } catch (restoreErr) {
      // The adapter is supposed to translate failures into typed outcomes;
      // a throw here means the adapter itself blew up (composition-root
      // mis-wire). Emit the failed metric + structured log; the member
      // undelete still committed and remains successful.
      renewalsMetrics.restoreOutcome(deps.tenant.slug, 'restore_failed');
      logger.error(
        {
          err: errKind(restoreErr),
          errName:
            restoreErr instanceof Error ? restoreErr.name : undefined,
          memberId,
          requestId: meta.requestId,
          cascade: 'f8_undelete_cycle_restore',
        },
        'undelete-member: renewals restore threw — member undelete succeeded',
      );
    }
  }
}
