/**
 * F8 Phase 7 T179 — Drizzle adapter for `PlanCatalogPort`.
 *
 * Read-only F2 plan catalogue projection for the tier-upgrade-evaluate
 * cron. Reads `membership_plans` directly via the F2 schema barrel
 * (sibling-module read-only access is permitted per Constitution
 * Principle III — `membershipPlans` is exported from the F2 public
 * barrel as the canonical read contract for sibling modules).
 *
 * Sort order: `min_turnover_minor_units ASC NULLS FIRST` so the cron
 * can ascend the eligibility ladder deterministically.
 *
 * Pure Infrastructure — only `@/lib/db` + F2 barrel imports.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans';
import type {
  PlanCatalogEntry,
  PlanCatalogPort,
} from '../../application/ports/plan-catalog-port';

async function listForTenantViaTx(
  tx: TenantTx,
  tenantId: string,
): Promise<ReadonlyArray<PlanCatalogEntry>> {
  // Defence-in-depth: `runInTenant` already sets `SET LOCAL ROLE
  // chamber_app + app.current_tenant` so RLS scopes the query, but we
  // also add an explicit `eq(tenantId)` predicate so a future RLS
  // policy regression cannot silently leak cross-tenant catalogue rows
  // into the eval cron's decision tree.
  const rows = await tx
    .select({
      planId: membershipPlans.planId,
      renewalTierBucket: membershipPlans.renewalTierBucket,
      minTurnoverThb: membershipPlans.minTurnoverMinorUnits,
      annualFeeThb: membershipPlans.annualFeeMinorUnits,
      isActive: membershipPlans.isActive,
    })
    .from(membershipPlans)
    .where(
      and(
        eq(membershipPlans.tenantId, tenantId),
        eq(membershipPlans.isActive, true),
        isNull(membershipPlans.deletedAt),
      ),
    )
    .orderBy(
      sql`${membershipPlans.minTurnoverMinorUnits} NULLS FIRST`,
      asc(membershipPlans.planId),
    );
  return rows.map((row) => ({
    planId: row.planId,
    renewalTierBucket: row.renewalTierBucket,
    minTurnoverThb: row.minTurnoverThb,
    annualFeeThb: row.annualFeeThb,
    isActive: row.isActive,
  }));
}

export const drizzlePlanCatalog: PlanCatalogPort = {
  async listForTenant(
    tenantId: string,
  ): Promise<ReadonlyArray<PlanCatalogEntry>> {
    return runInTenant(asTenantContext(tenantId), (tx) =>
      listForTenantViaTx(tx, tenantId),
    );
  },
};
