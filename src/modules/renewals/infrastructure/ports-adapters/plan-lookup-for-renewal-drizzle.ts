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

/** A single catalogue row's price/tier columns, as SELECTed below. */
interface PlanRow {
  readonly renewalTierBucket: string;
  readonly annualFeeMinorUnits: number;
}

/**
 * Assemble a `found` result from a resolved catalogue row — shared by
 * both the exact-year primary and the most-recent-active fallback so the
 * tier-bucket guard + minor-units→ThbDecimal conversion live in one place.
 *
 * Returns `{ status: 'not_found' }` when the row's tier bucket is not one
 * of the 5 valid buckets (defensive — the migration CHECK constraint
 * should make this impossible, but the type narrowing demands it).
 */
function frozenResultFromRow(row: PlanRow): PlanLookupForRenewalResult {
  if (!VALID_TIER_BUCKETS.has(row.renewalTierBucket as TierBucket)) {
    return { status: 'not_found' };
  }
  // F2 stores fees in minor units (satang for THB). Convert to a
  // decimal string matching the cycle's `frozen_plan_price_thb`
  // column (`decimal(12,2)`).
  const priceMinor = row.annualFeeMinorUnits;
  const baht = Math.floor(priceMinor / 100);
  const satang = priceMinor % 100;
  // Construction boundary (I-1): brand-validate the assembled
  // decimal(12,2) string into ThbDecimal. The minor-units split always
  // yields a well-formed `\d+\.\d{2}` value, so this never throws — it
  // pins the invariant at the point the frozen price is born from the
  // F2 catalogue minor-units column.
  const priceTHB = parseThbDecimal(`${baht}.${String(satang).padStart(2, '0')}`);
  return {
    status: 'found',
    plan: {
      tierBucket: row.renewalTierBucket as TierBucket,
      priceTHB,
      termMonths: 12,
      currency: 'THB',
    },
  };
}

export function makeDrizzlePlanLookupForRenewal(
  tenant: TenantContext,
): PlanLookupForRenewalPort {
  return {
    async loadPlanFrozenFields(input: {
      readonly tenantId: string;
      readonly planId: string;
      readonly fiscalYear: number;
      readonly requireActiveForYear: boolean;
    }): Promise<PlanLookupForRenewalResult> {
      return runInTenant(tenant, async (tx) => {
        // A `plan_id` is shared across `plan_year`s — the composite PK is
        // `(tenant_id, plan_id, plan_year)` and a planId carries one row
        // per year (e.g. 2026 + a pre-opened 2027 catalogue). MORE THAN
        // ONE year can be `is_active` at once. RLS scopes tenant;
        // `deleted_at IS NULL` filters soft-deletes throughout.
        //
        // 070 §86/4 — Step 1: EXACT-YEAR primary. Resolve the row for the
        // RELEVANT cycle's fiscal year directly (composite-PK unique), so
        // a current-period cycle freezes the CURRENT-year price even when a
        // future-year catalogue row is also active. This is the load-
        // bearing fix: the prior "most-recent ACTIVE row by plan_year DESC"
        // silently resolved a 2026 cycle to a 2027 active row.
        const exactRows = await tx
          .select({
            isActive: membershipPlans.isActive,
            renewalTierBucket: membershipPlans.renewalTierBucket,
            annualFeeMinorUnits: membershipPlans.annualFeeMinorUnits,
          })
          .from(membershipPlans)
          .where(
            and(
              eq(membershipPlans.planId, input.planId),
              eq(membershipPlans.planYear, input.fiscalYear),
              isNull(membershipPlans.deletedAt),
            ),
          )
          .limit(1);

        const exactRow = exactRows[0];
        if (exactRow) {
          // A row EXISTS for this exact year — the case the bug got wrong.
          if (input.requireActiveForYear && !exactRow.isActive) {
            // PLAN-CHANGE: cannot switch to a plan not offered for that
            // year. Do NOT fall through to a different year's active row.
            return { status: 'plan_inactive' };
          }
          // FREEZE (requireActiveForYear:false) → use this year's price
          // regardless of is_active (a seeded-but-not-yet-active next-year
          // row is the correct frozen price for that year). PLAN-CHANGE
          // with an active exact-year row also lands here.
          return frozenResultFromRow(exactRow);
        }

        // 070 §86/4 — EXACT-YEAR MISS: there is NO row (active OR inactive)
        // for this planId+fiscalYear.
        //
        // PLAN-CHANGE (requireActiveForYear:true) MUST NOT fall through to a
        // DIFFERENT year's active row — switching to a plan not offered for
        // THIS cycle's fiscal year would freeze the wrong year's price/tier
        // onto the §86/4 (and `getAnnualFeeSatang` would then reject the
        // mismatched (plan,year) at issue time anyway). Distinguish "planId
        // unknown" from "exists for other years only" via the probe so
        // confirm-renewal still maps not_found→plan_not_found vs
        // plan_inactive→plan_inactive. The cross-year fallback below is for
        // the FREEZE path ONLY.
        if (input.requireActiveForYear) {
          const offerProbe = await tx
            .select({ one: sql<number>`1` })
            .from(membershipPlans)
            .where(
              and(
                eq(membershipPlans.planId, input.planId),
                isNull(membershipPlans.deletedAt),
              ),
            )
            .limit(1);
          return offerProbe[0]
            ? { status: 'plan_inactive' }
            : { status: 'not_found' };
        }

        // FREEZE exact-year MISS → fall back to the EXISTING behaviour
        // UNCHANGED: most-recent ACTIVE row by `plan_year DESC`. This keeps
        // the not-yet-seeded future-year case + every current case (when the
        // exact-year row is absent) behaving exactly as before.
        const activeRows = await tx
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

        const activeRow = activeRows[0];
        if (!activeRow) {
          // No active row anywhere. Distinguish a planId that exists (but
          // has only inactive rows) from one that does not exist at all.
          // `confirm-renewal` maps `not_found` → `plan_not_found` and
          // `plan_inactive` → `plan_inactive` as two different member-
          // facing errors, so the distinction MUST be preserved.
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
        return frozenResultFromRow(activeRow);
      });
    },
  };
}
