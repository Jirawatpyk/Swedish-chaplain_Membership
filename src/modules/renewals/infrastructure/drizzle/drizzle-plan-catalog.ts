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
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans';
import { parseTierBucket } from '../../domain/value-objects/tier-bucket';
import { makeDrizzleRenewalAuditEmitter } from './drizzle-renewal-audit-emitter';
import type { PlanId } from '@/modules/members';
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
  // Phase 7 review-fix I-TYPE-1: narrow the raw `text` column at the
  // adapter boundary. Rows whose `renewal_tier_bucket` doesn't parse
  // are dropped + warn-logged so an upstream DB migration drift never
  // silently bypasses the eligibility decision tree.
  //
  // Phase 7 review-fix Round 2 IMP-6: explicit forensic chain on
  // each drop — bumps `planCatalogueUnparseableBucket{tenant}`
  // counter (Vercel alert target) + emits
  // `tier_upgrade_catalogue_row_dropped` audit per dropped row.
  const result: PlanCatalogEntry[] = [];
  const dropped: Array<{ planId: string; rawBucket: string }> = [];
  for (const row of rows) {
    const bucketParse = parseTierBucket(row.renewalTierBucket);
    if (!bucketParse.ok) {
      dropped.push({
        planId: row.planId,
        rawBucket: row.renewalTierBucket,
      });
      logger.warn(
        {
          tenantId,
          planId: row.planId,
          rawBucket: row.renewalTierBucket,
        },
        '[plan-catalog] dropping plan with unparseable renewal_tier_bucket',
      );
      continue;
    }
    // Adapt minor-units (satang) → integer THB at the boundary so the
    // Application layer's `decideUpgrade` can compare against
    // `members.turnover_thb` (integer THB) without scale mismatch. The
    // F2 schema stores annual fee + min turnover in `*_minor_units`
    // (bigint, satang); F3 stores `members.turnover_thb` as integer THB.
    // Without this conversion, `candidate.turnoverThb >= target.minTurnoverThb`
    // compares THB to satang and is off by 100×.
    result.push({
      planId: row.planId,
      renewalTierBucket: bucketParse.value,
      minTurnoverThb:
        row.minTurnoverThb !== null
          ? Math.floor(row.minTurnoverThb / 100)
          : null,
      annualFeeThb: Math.floor(row.annualFeeThb / 100),
      isActive: row.isActive,
    });
  }

  // Emit one audit + counter per dropped row. The audit emitter is
  // tx-bound; we use the fire-and-forget `emit()` because dropping a
  // row is an observability signal, not a state mutation we want to
  // bind to the calling tx.
  if (dropped.length > 0) {
    const auditEmitter = makeDrizzleRenewalAuditEmitter(
      asTenantContext(tenantId),
    );
    for (const drop of dropped) {
      renewalsMetrics.planCatalogueUnparseableBucket(tenantId);
      try {
        await auditEmitter.emit(
          {
            type: 'tier_upgrade_catalogue_row_dropped',
            payload: {
              plan_id: drop.planId as PlanId,
              raw_bucket: drop.rawBucket,
            },
          },
          {
            tenantId,
            actorUserId: null,
            actorRole: 'system',
            correlationId: 'plan-catalog-unparseable',
            requestId: null,
          },
        );
      } catch (e) {
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId,
            planId: drop.planId,
          },
          '[plan-catalog] catalogue_row_dropped audit emit failed',
        );
      }
    }
  }
  return result;
}

/**
 * Round 6 S-001 — factory pattern matching sibling repos
 * (`makeDrizzleTierUpgradeSuggestionRepo`, `makeDrizzleRenewalCycleRepo`,
 * etc.). The previous singleton-with-internal-`asTenantContext` form
 * worked correctly but diverged from the codebase factory convention,
 * making it ambiguous to readers whether the singleton was thread-safe
 * with respect to tenant scope.
 *
 * The singleton form is preserved as `drizzlePlanCatalog` for back-
 * compat with the existing `renewals-deps.ts` wiring; new callsites
 * SHOULD prefer `makeDrizzlePlanCatalog(tenantContext)` so the tenant
 * binding is explicit.
 */
export function makeDrizzlePlanCatalog(
  tenant: TenantContext,
): PlanCatalogPort {
  return {
    async listForTenant(
      tenantId: string,
    ): Promise<ReadonlyArray<PlanCatalogEntry>> {
      // Verify the caller's tenantId matches the bound tenant — fail
      // loudly on mismatch (closes the gap where the old singleton
      // would silently re-bind to whatever tenantId was passed).
      if (tenantId !== tenant.slug) {
        throw new Error(
          `makeDrizzlePlanCatalog: tenantId mismatch — bound to ${tenant.slug} but called with ${tenantId}`,
        );
      }
      return runInTenant(tenant, (tx) =>
        listForTenantViaTx(tx, tenantId),
      );
    },
  };
}

/**
 * Back-compat singleton — accepts any tenantId and constructs the
 * tenant context lazily. Pre-Round-6 export shape; new code should
 * use the factory above.
 */
export const drizzlePlanCatalog: PlanCatalogPort = {
  async listForTenant(
    tenantId: string,
  ): Promise<ReadonlyArray<PlanCatalogEntry>> {
    return runInTenant(asTenantContext(tenantId), (tx) =>
      listForTenantViaTx(tx, tenantId),
    );
  },
};
