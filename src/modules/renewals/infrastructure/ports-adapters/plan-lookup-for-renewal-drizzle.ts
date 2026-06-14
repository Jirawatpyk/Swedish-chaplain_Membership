/**
 * F8 Phase 5 Wave C → Production · `PlanLookupForRenewalPort` adapter.
 *
 * Drizzle implementation of the F8 → F2 plan-lookup port. Used by the
 * T122 confirm-renewal use-case's optional plan-change branch (FR-021b
 * atomic frozen-price update). Reads `membership_plans` directly via
 * deep-import of F2's schema — same precedent as `drizzle-renewal-cycle-repo.ts`
 * which deep-imports F3 `members` for the company-name LEFT JOIN.
 *
 * Why deep import vs. F2 `getPlan` use-case: F8 needs the
 * `renewal_tier_bucket` column which was backfilled onto F2's
 * `membership_plans` table by F8 migration 0094 but is NOT exposed on
 * F2's public Plan domain entity. A direct SELECT keeps the read
 * narrow + avoids growing F2's surface for F8-internal needs.
 *
 * Term-months: F2's `Plan` model has no per-plan term column; the
 * F8 cycle defaults to 12-month terms (data-model.md § 2.1) so we
 * emit 12 here. Multi-year cycles are represented by the cycle's
 * `cycleLengthMonths` (e.g. 36 for Diamond Partnership) — that's the
 * cycle's own axis, not the plan's, and stays unchanged on plan-change.
 *
 * Currency: F2 is THB-only today (no per-plan currency column); the
 * adapter emits 'THB' literal. When F2 widens to multi-currency, this
 * adapter inherits the column read.
 *
 * Pure Infrastructure — uses only `@/lib/db` + F2 schema deep import +
 * the port interface (no framework / Application-layer imports).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { parseThbDecimal } from '@/lib/money';
import type { TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans';
import type {
  PlanFrozenFields,
  PlanLookupForRenewalPort,
  PlanLookupForRenewalResult,
} from '../../application/ports/plan-lookup-for-renewal';

const VALID_TIER_BUCKETS = new Set([
  'thai_alumni',
  'start_up',
  'regular',
  'premium',
  'partnership',
] as const);

type TierBucket = PlanFrozenFields['tierBucket'];

export function makeDrizzlePlanLookupForRenewal(
  tenant: TenantContext,
): PlanLookupForRenewalPort {
  return {
    async loadPlanFrozenFields(input: {
      readonly tenantId: string;
      readonly planId: string;
    }): Promise<PlanLookupForRenewalResult> {
      return runInTenant(tenant, async (tx) => {
        // Two-step active-first lookup. A `plan_id` is shared across
        // `plan_year`s — the table's composite PK is
        // `(tenant_id, plan_id, plan_year)` and a planId carries
        // multiple rows (e.g. 2025 + 2026 catalogue carry-over). The
        // real swecham catalogue also carries stray INACTIVE
        // future-year rows (plan_year 2068 + 2028). So a naive
        // "most-recent plan_year row, then check is_active" picks the
        // stray inactive future row and returns `plan_inactive` even
        // when an active current-year row exists. RLS scopes tenant;
        // `deleted_at IS NULL` filters soft-deletes throughout.
        //
        // Step 1 — most-recent ACTIVE row. This is the correct
        // most-recent-active price and is what the FR-021b frozen-price
        // contract needs. Filtering `is_active = true` in the WHERE
        // (not after LIMIT) is what fixes the stray-row bug.
        const rows = await tx
          .select({
            renewalTierBucket: membershipPlans.renewalTierBucket,
            annualFeeMinorUnits: membershipPlans.annualFeeMinorUnits,
          })
          .from(membershipPlans)
          .where(
            and(
              eq(membershipPlans.planId, input.planId),
              isNull(membershipPlans.deletedAt),
              eq(membershipPlans.isActive, true),
            ),
          )
          .orderBy(desc(membershipPlans.planYear))
          .limit(1);

        const row = rows[0];
        if (!row) {
          // Step 2 — no active row. Distinguish a planId that exists
          // (but has only inactive rows) from one that does not exist
          // at all. `confirm-renewal` maps `not_found` →
          // `plan_not_found` and `plan_inactive` → `plan_inactive` as
          // two different member-facing errors on a plan-change, so the
          // distinction MUST be preserved.
          const inactiveProbe = await tx
            .select({ one: sql<number>`1` })
            .from(membershipPlans)
            .where(
              and(
                eq(membershipPlans.planId, input.planId),
                isNull(membershipPlans.deletedAt),
              ),
            )
            .limit(1);
          return inactiveProbe[0]
            ? { status: 'plan_inactive' }
            : { status: 'not_found' };
        }
        if (!VALID_TIER_BUCKETS.has(row.renewalTierBucket as TierBucket)) {
          // Defensive — the migration's CHECK constraint should make
          // this impossible, but the type narrowing demands it.
          return { status: 'not_found' };
        }
        // F2 stores fees in minor units (satang for THB). Convert to
        // decimal string matching the cycle's `frozen_plan_price_thb`
        // column (`decimal(12,2)`).
        const priceMinor = row.annualFeeMinorUnits;
        const baht = Math.floor(priceMinor / 100);
        const satang = priceMinor % 100;
        // Construction boundary (I-1): brand-validate the assembled
        // decimal(12,2) string into ThbDecimal. The minor-units split
        // always yields a well-formed `\d+\.\d{2}` value, so this never
        // throws — it pins the invariant at the point the frozen price
        // is born from the F2 catalogue minor-units column.
        const priceTHB = parseThbDecimal(
          `${baht}.${String(satang).padStart(2, '0')}`,
        );
        return {
          status: 'found',
          plan: {
            tierBucket: row.renewalTierBucket as TierBucket,
            priceTHB,
            termMonths: 12,
            currency: 'THB',
          },
        };
      });
    },
  };
}
