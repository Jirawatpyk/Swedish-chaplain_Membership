/**
 * F8 → F2 plan-lookup port (Phase 5 Wave B — T122 plan-change branch).
 *
 * T122 confirm-renewal lets the member optionally pick a different F2
 * plan during the confirm flow (FR-025). The cycle's `frozen_plan_*`
 * columns must atomically update to the new plan's price/term/tier.
 *
 * This port narrows F2's `getPlan` to JUST the fields T122 needs:
 * tier-bucket + price + term + currency. Adapter composition wires
 * F2's full getPlan use-case in the production deps factory; tests
 * pass an in-memory mock returning the desired fields.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { ThbDecimal } from '@/lib/money';

export interface PlanFrozenFields {
  readonly tierBucket: 'thai_alumni' | 'start_up' | 'regular' | 'premium' | 'partnership';
  /**
   * Frozen plan price as a brand-validated `decimal(12,2)` THB value
   * mirroring the F2 `priceThb` column. `ThbDecimal` (not bare
   * `string`) so a display label / `planYear.toString()` / SEK price
   * cannot be assigned into the §86/4 frozen-price slot it flows into
   * (I-1, 068 speckit-review).
   */
  readonly priceTHB: ThbDecimal;
  readonly termMonths: number;
  readonly currency: 'THB' | 'SEK' | 'EUR' | 'USD';
}

export type PlanLookupForRenewalResult =
  | { readonly status: 'found'; readonly plan: PlanFrozenFields }
  | { readonly status: 'not_found' }
  | { readonly status: 'plan_inactive' };

export interface PlanLookupForRenewalPort {
  loadPlanFrozenFields(input: {
    readonly tenantId: string;
    readonly planId: string;
    /**
     * The fiscal year of the relevant cycle (FREEZE: the new cycle's
     * resolved `periodFrom`; PLAN-CHANGE: the target cycle's
     * `periodFrom`), derived via `deriveFiscalYear` from `@/lib/fiscal-year`.
     *
     * 070 §86/4 fix — resolution is EXACT-YEAR-FIRST. A `plan_id` carries
     * one row per `plan_year` (composite PK `(tenant_id, plan_id,
     * plan_year)`), and more than one year can be `is_active` at once
     * (e.g. an admin pre-opening next year's catalogue). The prior "most-
     * recent ACTIVE row ordered by plan_year DESC" resolution silently
     * resolved a CURRENT-period cycle's frozen §86/4 price to a FUTURE-year
     * row whenever such a row existed — a latent tax-correctness footgun.
     * Threading the cycle's own year pins the resolution to the correct
     * catalogue row.
     */
    readonly fiscalYear: number;
    /**
     * Whether the exact-year row MUST be active to resolve.
     *
     *   - `false` (FREEZE callers — `createCycleInTx`, the
     *     `accept-tier-upgrade` email display-name lookup, the
     *     `reschedule-on-plan-change` tier-bucket lookup): an exact-year
     *     row resolves to `found` REGARDLESS of `is_active`. A seeded-but-
     *     not-yet-active next-year row is the correct frozen price for that
     *     year.
     *   - `true` (PLAN-CHANGE callers — `confirm-renewal`): an exact-year
     *     row resolves only when `is_active`; an inactive exact-year row →
     *     `plan_inactive` (the member cannot switch to a plan not offered
     *     for that year — it must NOT fall through to a different year).
     *
     * The exact-year-MISS fallback (most-recent ACTIVE row by `plan_year
     * DESC`) is unchanged by this flag — it preserves the prior behaviour
     * for every year that has no exact-year row.
     */
    readonly requireActiveForYear: boolean;
  }): Promise<PlanLookupForRenewalResult>;
}
