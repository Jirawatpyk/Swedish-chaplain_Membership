/**
 * F8 Phase 7 T179 — `PlanCatalogPort` Application port.
 *
 * Read-only F2 plan catalogue surface for the tier-upgrade-evaluate
 * cron. Returns the per-plan upgrade thresholds (`min_turnover_minor_units`)
 * + `renewal_tier_bucket` ordering so the cron can locate the
 * "next-higher tier" for each candidate member.
 *
 * Pure interface — no F2 SDK / Drizzle / framework imports
 * (Constitution Principle III). Adapter wires F2 barrel
 * `listPlans` + `membershipPlans` table to materialise this.
 */

/**
 * Lightweight projection of an F2 `MembershipPlan` carrying ONLY the
 * fields the upgrade-eval cron needs. Avoids leaking the full F2
 * `Plan` shape (BenefitMatrix, LocaleText, etc.) into F8's Application
 * layer.
 */
export interface PlanCatalogEntry {
  readonly planId: string;
  /** Full bucket label per F2 5-bucket enum (`thai_alumni` | … | `partnership`). */
  readonly renewalTierBucket: string;
  /**
   * Minimum turnover threshold (in THB minor units → satang/baht stored
   * as integer). Null when the plan has no eligibility floor.
   */
  readonly minTurnoverThb: number | null;
  /** Annual fee (THB minor units) — used for invoice-volume threshold (N×fee). */
  readonly annualFeeThb: number;
  readonly isActive: boolean;
}

export interface PlanCatalogPort {
  /**
   * Returns active + non-deleted plans for a tenant. Ordered by
   * `min_turnover_minor_units ASC NULLS FIRST` so the cron can
   * ascend the eligibility ladder deterministically. Empty array
   * when the tenant has no plans configured.
   */
  listForTenant(tenantId: string): Promise<ReadonlyArray<PlanCatalogEntry>>;
}
