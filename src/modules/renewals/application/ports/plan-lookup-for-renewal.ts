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
import type { TenantTx } from '@/lib/db';
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

/**
 * The `loadPlanFrozenFields` input — shared by the connection-fresh variant and
 * the in-tx variant so the two never drift.
 */
export interface LoadPlanFrozenFieldsInput {
  readonly tenantId: string;
  readonly planId: string;
  /**
   * The fiscal year of the relevant cycle — see `loadPlanFrozenFields` below
   * for the full EXACT-YEAR-FIRST resolution contract.
   */
  readonly fiscalYear: number;
  readonly mode: 'freeze' | 'offer';
}

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
     * Resolution MODE — which of the two distinct plan-resolution
     * contracts this lookup follows. Replaces the prior
     * `requireActiveForYear` boolean, which named one mechanical sub-effect
     * (the exact-year active check) of a two-part policy that ALSO governs
     * the exact-year-MISS fallback; `mode` names the INTENT, so the call
     * site reads as the contract rather than a bare `true`/`false`.
     *
     *   - `'freeze'` (FREEZE callers — `createCycleInTx`, the
     *     `accept-tier-upgrade` email display-name lookup, the
     *     `reschedule-on-plan-change` tier-bucket lookup): snapshot a price/
     *     tier for billing or display. An exact-year row resolves to `found`
     *     REGARDLESS of `is_active` (a seeded-but-not-yet-active next-year
     *     row is the correct frozen price for that year); an exact-year MISS
     *     falls back to the most-recent ACTIVE row by `plan_year DESC`,
     *     preserving the prior behaviour for not-yet-seeded years.
     *   - `'offer'` (PLAN-CHANGE callers — `confirm-renewal`): validate the
     *     member may switch TO this plan FOR this year. An exact-year row
     *     resolves only when `is_active` (an inactive exact-year row →
     *     `plan_inactive`); an exact-year MISS does NOT fall through to a
     *     different year — it probes existence and returns `plan_inactive`
     *     (the planId exists for other years) or `not_found`. Switching to a
     *     plan not offered for THIS cycle's year would freeze the wrong
     *     year's §86/4 price.
     */
    readonly mode: 'freeze' | 'offer';
  }): Promise<PlanLookupForRenewalResult>;

  /**
   * Finding #21 — the in-tx sibling of `loadPlanFrozenFields`. Reads the SAME
   * rows via the SAME EXACT-YEAR-FIRST resolution, but on the CALLER's `tx`
   * instead of opening its own `runInTenant`. Required by the plan-change →
   * billing remediation, which runs on `change-plan`'s tx while it holds the
   * member row FOR UPDATE + the per-cycle advisory lock: the non-tx variant's
   * nested `runInTenant` there is a 2nd pooled connection acquired UNDER a held
   * row lock (the repo's "never nest runInTenant while holding a row lock"
   * guardrail — benign today because `membership_plans` is never row-locked by
   * these paths, but a latent deadlock footgun the pooler's dropped
   * statement_timeout would turn into a hang-forever). Threading `tx` keeps the
   * read on the SAME connection. Tenant scope comes from the inherited GUC set
   * by the caller's `runInTenant`; the explicit `tenantId` on the input is
   * defence-in-depth only. Mirrors the F4 invoice-due bridge's `*InTx` methods.
   */
  loadPlanFrozenFieldsInTx(
    tx: TenantTx,
    input: LoadPlanFrozenFieldsInput,
  ): Promise<PlanLookupForRenewalResult>;
}
