/**
 * F7 US3 AS5 + AS3 — `get-member-broadcast.ts` Application use-case.
 *
 * Read-path for `/portal/broadcasts/[id]`. Resolves a single broadcast
 * iff the requesting member owns it; otherwise emits the
 * `broadcast_cross_member_probe` audit event and returns `not_found`
 * (the route surfaces 404 in both cases — anti-enumeration).
 *
 * Co-fetches the aggregated delivery breakdown for AS3 so the page
 * server-component does ONE awaited orchestration call instead of two.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { AuditPort } from '../ports/audit-port';
import { f7RetentionFor } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

export type GetMemberBroadcastError = {
  readonly kind: 'broadcast.not_found';
};

export interface DeliveryBreakdown {
  readonly delivered: number;
  readonly bounced: number;
  readonly softBounced: number;
  readonly complained: number;
  readonly sent: number;
  readonly total: number;
}

export interface GetMemberBroadcastDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly audit: AuditPort;
}

export interface GetMemberBroadcastInput {
  readonly memberId: MemberId;
  readonly broadcastId: BroadcastId;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface GetMemberBroadcastOutput {
  readonly broadcast: Broadcast;
  readonly delivery: DeliveryBreakdown;
}

export async function getMemberBroadcast(
  deps: GetMemberBroadcastDeps,
  input: GetMemberBroadcastInput,
): Promise<Result<GetMemberBroadcastOutput, GetMemberBroadcastError>> {
  const found = await deps.broadcastsRepo.findOwnedByMember(
    deps.tenant.slug,
    input.memberId,
    input.broadcastId,
  );

  if (found.broadcast === null) {
    if (found.probeKind === 'cross_member') {
      // Cross-member probe audit (Q19 + AS5 per-tenant scope). tx=null
      // → auto-commit. Failure is logged at error level so an audit-port
      // outage during attack-traffic is observable rather than silently
      // swallowed (probe-detection observability matters most exactly
      // when probes arrive in volume).
      try {
        await deps.audit.emit(null, {
          tenantId: deps.tenant.slug,
          requestId: input.requestId,
          eventType: 'broadcast_cross_member_probe',
          actorUserId: input.actorUserId,
          summary: `Member ${input.memberId} probed broadcast ${input.broadcastId} owned by another member`,
          payload: {
            memberId: input.memberId,
            broadcastId: input.broadcastId,
            retentionYears: f7RetentionFor('broadcast_cross_member_probe'),
          },
        });
      } catch (e) {
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: deps.tenant.slug,
            memberId: input.memberId,
            broadcastId: input.broadcastId,
            actorUserId: input.actorUserId,
            requestId: input.requestId,
          },
          'broadcasts.cross_member_probe.audit_emit_failed',
        );
        // Continue to err() — anti-enumeration response (404) is
        // preserved at the HTTP boundary regardless of audit success.
      }
    }
    return err({ kind: 'broadcast.not_found' });
  }

  const counts = await deps.broadcastsRepo.aggregateDeliveryCountsForBroadcast(
    deps.tenant.slug,
    input.broadcastId,
  );

  const total =
    counts.delivered +
    counts.bounced +
    counts.softBounced +
    counts.complained +
    counts.sent;

  return ok({
    broadcast: found.broadcast,
    delivery: { ...counts, total },
  });
}
