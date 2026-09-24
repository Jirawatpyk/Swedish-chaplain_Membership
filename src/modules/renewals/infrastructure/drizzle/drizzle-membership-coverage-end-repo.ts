/**
 * Migration 0305 — Drizzle adapter for `MembershipCoverageEndRepo` (the
 * `renewal_cycles.end_coverage_*` request columns). See the port docstring.
 *
 * In-tx writes rely on the RLS GUC inherited from the caller's `runInTenant`
 * (same precedent as `markRejectRefundInitiatedInTx`); the standalone list
 * opens its own `runInTenant` and adds an explicit `tenant_id` predicate
 * (Principle I two-layer).
 */
import { and, asc, eq, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles } from '../schema-renewal-cycles';
import { asCycleId, type CycleId } from '../../domain/renewal-cycle';
import { TERMINAL_CYCLE_STATUSES } from '../../domain/value-objects/cycle-status';
import type {
  MembershipCoverageEndRepo,
  MembershipCoverageEndRequest,
} from '../../application/ports/membership-coverage-end-repo';

export function makeDrizzleMembershipCoverageEndRepo(
  tenant: TenantContext,
): MembershipCoverageEndRepo {
  return {
    async stampInTx(tx, _tenantId, cycleId: CycleId, request) {
      const updated = await tx
        .update(renewalCycles)
        .set({
          endCoverageRequestedAt: new Date(request.requestedAt),
          endCoverageRefundId: request.refundId,
          endCoverageInvoiceId: request.invoiceId,
          endCoverageActorUserId: request.actorUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            notInArray(renewalCycles.status, [...TERMINAL_CYCLE_STATUSES]),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async clearInTx(tx, _tenantId, cycleId: CycleId, expectedRefundId) {
      const updated = await tx
        .update(renewalCycles)
        .set({
          endCoverageRequestedAt: null,
          endCoverageRefundId: null,
          endCoverageInvoiceId: null,
          endCoverageActorUserId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(renewalCycles.cycleId, cycleId),
            isNotNull(renewalCycles.endCoverageRequestedAt),
            expectedRefundId === null
              ? isNull(renewalCycles.endCoverageRefundId)
              : eq(renewalCycles.endCoverageRefundId, expectedRefundId),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async listPending(tenantId, limit) {
      const rows = await runInTenant(tenant, (tx) =>
        tx
          .select({
            cycleId: renewalCycles.cycleId,
            memberId: renewalCycles.memberId,
            requestedAt: renewalCycles.endCoverageRequestedAt,
            refundId: renewalCycles.endCoverageRefundId,
            invoiceId: renewalCycles.endCoverageInvoiceId,
            actorUserId: renewalCycles.endCoverageActorUserId,
          })
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenantId),
              isNotNull(renewalCycles.endCoverageRequestedAt),
              notInArray(renewalCycles.status, [...TERMINAL_CYCLE_STATUSES]),
            ),
          )
          .orderBy(asc(renewalCycles.endCoverageRequestedAt))
          .limit(limit),
      );
      return rows.map(
        (r): MembershipCoverageEndRequest => ({
          cycleId: asCycleId(r.cycleId),
          memberId: r.memberId,
          requestedAt: r.requestedAt!.toISOString(),
          refundId: r.refundId,
          invoiceId: r.invoiceId,
          actorUserId: r.actorUserId,
        }),
      );
    },
  };
}
