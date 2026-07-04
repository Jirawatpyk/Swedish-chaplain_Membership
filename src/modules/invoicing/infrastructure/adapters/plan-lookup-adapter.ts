/**
 * T050 — Plan lookup adapter (F4).
 *
 * Reads annual fee (satang) for (tenant, plan, year) from the F2
 * `membership_plans` table via the plans module's barrel-exposed repo.
 */
import { and, eq, isNull } from 'drizzle-orm';
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
            // 070 §86/4 advisory — exclude SOFT-DELETED catalogue rows so a
            // soft-deleted plan-year row is NOT billable on a tax invoice.
            // Harmonises with the F8 frozen-plan adapter
            // (`plan-lookup-for-renewal-drizzle.ts`), which already filters
            // `deleted_at IS NULL`. NOTE: NO `is_active` filter — a seeded-
            // but-INACTIVE next-year row must still validate for the FK + fee
            // when a next-year cycle bills (inactive ≠ deleted). A deleted
            // row → null → the caller's `plan_not_found` gate.
            isNull(membershipPlans.deletedAt),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    // `annualFeeMinorUnits` is stored as F2's minor units (satang for THB).
    return BigInt(row.fee);
  },

  // 088 T036 (FR-011) — resolve the plan display name for the membership line
  // description. SAME (tenant, plan, year) + `deleted_at IS NULL` filter as
  // `getAnnualFeeSatang` (so a create-invoice-draft that passed the fee gate
  // resolves a name here too). `plan_name` is a NOT-NULL `LocaleText` jsonb
  // (`{ en, th?, sv? }`, `en` required); flatten it to two plain strings at the
  // boundary so the plans-domain type never leaks into the Application port.
  async getPlanName(
    tenantId: string,
    planId: string,
    planYear: number,
  ): Promise<{ th: string; en: string } | null> {
    const ctx = asTenantContext(tenantId);
    const rows = await runInTenant(ctx, (tx) =>
      tx
        .select({ name: membershipPlans.planName })
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.tenantId, tenantId),
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, planYear),
            isNull(membershipPlans.deletedAt),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return null;
    return { th: row.name.th ?? row.name.en, en: row.name.en };
  },
};
