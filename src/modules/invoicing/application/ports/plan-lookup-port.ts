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
  /**
   * 088-invoice-tax-flow-redesign — T036 [US4] (FR-011). The plan's display name
   * resolved to `{ th, en }` for the membership invoice line description (plan
   * name + coverage period). `th` falls back to `en` when the plan has no Thai
   * translation (F2 `LocaleText` requires only `en`). Returns `null` when the
   * (tenant, plan, year) catalogue row is absent or soft-deleted — same filter
   * as `getAnnualFeeSatang`. Application never sees the plans-domain `LocaleText`
   * type — the adapter flattens it to two plain strings at the boundary.
   */
  getPlanName(
    tenantId: string,
    planId: string,
    planYear: number,
  ): Promise<{ th: string; en: string } | null>;
}
