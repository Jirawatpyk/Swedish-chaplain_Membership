/**
 * T050 — Plan lookup adapter (F4).
 *
 * Reads annual fee (satang) for (tenant, plan, year) from the F2
 * `membership_plans` table via the plans module's barrel-exposed repo.
 */
import { and, eq } from 'drizzle-orm';
import type { PlanLookupPort } from '../../application/ports/plan-lookup-port';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

export const planLookupAdapter: PlanLookupPort = {
  async getAnnualFeeSatang(
    tenantId: string,
    planId: string,
    planYear: number,
  ): Promise<bigint | null> {
    const ctx = asTenantContext(tenantId);
    const rows = await runInTenant(ctx, (tx) =>
      tx
        .select({ fee: membershipPlans.annualFeeMinorUnits })
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenantId),
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, planYear),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    // `annualFeeMinorUnits` is stored as F2's minor units (satang for THB).
    return BigInt(row.fee);
  },
};
