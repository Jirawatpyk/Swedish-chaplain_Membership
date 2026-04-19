/**
 * T032 — Plan lookup port (F4).
 * Reads annual fee (satang) for (tenant, plan, year) via `@/modules/plans` barrel.
 */
export interface PlanLookupPort {
  getAnnualFeeSatang(
    tenantId: string,
    planId: string,
    planYear: number,
  ): Promise<bigint | null>;
}
