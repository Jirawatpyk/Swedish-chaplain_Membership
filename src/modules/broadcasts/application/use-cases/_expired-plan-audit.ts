/**
 * Slice B (Phase 8 — T171 / AS5) — `broadcast_sent_with_expired_member_plan`.
 *
 * Emitted when the originating member's CURRENT plan differs from the snapshot
 * taken at submit, or when the plan no longer entitles them at all. The
 * broadcast still goes out — that is the AS5 decision — so this row is the only
 * evidence an admin has when auditing "this member sent an E-Blast as if they
 * still held the lower tier". Forensic only: never throws, never blocks the
 * dispatch result.
 *
 * Extracted from `dispatch-scheduled-broadcast.ts` in 108 Phase 9. The import
 * path could not perform this check at all — `BuildAudienceTickDeps` declared no
 * `plansBridge`, so it was unrepresentable rather than merely omitted, which is
 * why no diff of the two paths revealed it. Sharing the function rather than
 * copying it is the point: two implementations of one forensic rule drift, and a
 * quota'd paid benefit is exactly where that matters.
 *
 * `sentBroadcast` and `now` were parameters on the original and were never read
 * in its body; they are not carried over.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import type { PlansBridgePort } from '../ports/plans-bridge-port';

export interface ExpiredPlanAuditDeps {
  readonly tenant: TenantContext;
  readonly plansBridge: PlansBridgePort;
  readonly audit: AuditPort;
}

export async function emitExpiredPlanAuditIfApplicable(args: {
  readonly deps: ExpiredPlanAuditDeps;
  readonly broadcast: Broadcast;
}): Promise<void> {
  const { deps, broadcast } = args;

  let planLookup;
  try {
    planLookup = await deps.plansBridge.getPlanForMember(
      deps.tenant,
      broadcast.requestedByMemberId,
    );
  } catch (e) {
    // Plan-bridge threw (Neon outage, repository bug). Forensic audit is
    // best-effort; log + skip without blocking the dispatch result.
    logger.error(
      {
        err: errKind(e),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        memberId: broadcast.requestedByMemberId,
      },
      'broadcasts.dispatch.expired_plan_check_threw',
    );
    return;
  }

  const noLongerEntitled = !planLookup.ok;
  const planChanged =
    planLookup.ok &&
    planLookup.value.planId !== broadcast.requestedByMemberPlanIdSnapshot;

  if (!noLongerEntitled && !planChanged) {
    return; // No expired-plan condition; no audit emit
  }

  try {
    await deps.audit.emit(null, {
      tenantId: deps.tenant.slug,
      eventType: 'broadcast_sent_with_expired_member_plan',
      actorUserId: 'system:cron',
      summary: `Broadcast ${broadcast.broadcastId} dispatched despite member plan change since submit`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        planAtSubmit: broadcast.requestedByMemberPlanIdSnapshot,
        planAtDispatch: planLookup.ok ? planLookup.value.planId : null,
        planLookupError: planLookup.ok ? null : planLookup.error.kind,
        currentlyEntitled: planLookup.ok,
      },
      requestId: null,
    });
  } catch (auditErr) {
    logger.error(
      {
        err: errKind(auditErr),
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
      },
      'broadcasts.dispatch.expired_plan_audit_emit_failed',
    );
  }
}
