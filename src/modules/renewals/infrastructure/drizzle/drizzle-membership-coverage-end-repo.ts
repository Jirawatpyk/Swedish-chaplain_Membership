/**
 * Migration 0306 — Drizzle adapter for `MembershipCoverageEndRepo` (the
 * `renewal_cycles.end_coverage_*` request columns). See the port docstring.
 *
 * Every query carries an explicit `tenant_id` predicate ON TOP of the RLS the
 * caller's `runInTenant` sets (Principle I two-layer isolation). A request is
 * only ever stamped / listed on an OPEN cycle (upcoming | reminded |
 * awaiting_payment) — never on `pending_admin_reactivation`, whose held
 * payment belongs to the reactivation review.
 */
import { and, asc, eq, inArray, isNotNull, isNull, not, notInArray, or, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles } from '../schema-renewal-cycles';
import { asCycleId, type CycleId } from '../../domain/renewal-cycle';
import { OPEN_CYCLE_STATUSES } from '../../domain/value-objects/cycle-status';
import type {
  MembershipCoverageEndRepo,
  MembershipCoverageEndRequest,
} from '../../application/ports/membership-coverage-end-repo';

const CLEARED = {
  endCoverageRequestedAt: null,
  endCoverageRefundId: null,
  endCoverageInvoiceId: null,
  endCoverageActorUserId: null,
} as const;

export function makeDrizzleMembershipCoverageEndRepo(
  tenant: TenantContext,
): MembershipCoverageEndRepo {
  return {
    async stampInTx(tx, tenantId, cycleId: CycleId, request) {
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
            eq(renewalCycles.tenantId, tenantId),
            eq(renewalCycles.cycleId, cycleId),
            inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
            // A refund-backed request (which WAITS for settlement) never
            // overwrites a plain one (which ends coverage on the next pass):
            // the plain request is the stronger, already-due decision.
            request.onlyIfAbsent === true
              ? isNull(renewalCycles.endCoverageRequestedAt)
              : request.refundId === null
                ? sql`TRUE`
                : or(
                    isNull(renewalCycles.endCoverageRequestedAt),
                    isNotNull(renewalCycles.endCoverageRefundId),
                  ),
          ),
        )
        .returning({ cycleId: renewalCycles.cycleId });
      return updated.length > 0;
    },

    async clearInTx(tx, tenantId, cycleId: CycleId, expectedRefundId) {
      const updated = await tx
        .update(renewalCycles)
        .set({ ...CLEARED, updatedAt: new Date() })
        .where(
          and(
            eq(renewalCycles.tenantId, tenantId),
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
              inArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
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

    async clearStranded(tenantId) {
      // A request left on a cycle that is no longer OPEN — except the
      // resulting `cancelled`/`coverage_ended` row, where it stays as
      // forensics. Clearing it means a lapsed → awaiting_payment comeback can
      // never revive a stale request.
      const cleared = await runInTenant(tenant, (tx) =>
        tx
          .update(renewalCycles)
          .set({ ...CLEARED, updatedAt: new Date() })
          .where(
            and(
              eq(renewalCycles.tenantId, tenantId),
              isNotNull(renewalCycles.endCoverageRequestedAt),
              notInArray(renewalCycles.status, [...OPEN_CYCLE_STATUSES]),
              not(
                and(
                  eq(renewalCycles.status, 'cancelled'),
                  eq(renewalCycles.closedReason, 'coverage_ended'),
                )!,
              ),
            ),
          )
          .returning({ cycleId: renewalCycles.cycleId }),
      );
      return cleared.map((r) => asCycleId(r.cycleId));
    },
  };
}
