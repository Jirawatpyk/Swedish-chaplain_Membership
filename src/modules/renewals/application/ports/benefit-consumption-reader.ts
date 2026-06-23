/**
 * F8 renewal benefit-summary — `BenefitConsumptionReader` port.
 *
 * The renewal page (`/portal/renewal/[memberId]`) shows the member's
 * metered benefit consumption (E-Blasts sent, cultural tickets used).
 * Rather than re-derive that here, F8 REUSES the F9 insights
 * `computeBenefitUsage` use-case (the same source `/portal/benefits`
 * consumes) — the production adapter
 * (`benefit-consumption-reader-insights.ts`) calls insights and maps its
 * `quantifiable` shape onto `BenefitConsumptionEntry`.
 *
 * Returning `null` (rather than throwing) is the documented "unavailable"
 * signal: the use-case maps `null` to `benefits=[] / benefitsAvailable=false`
 * so the page renders the neutral "Benefit summary unavailable" copy
 * instead of misleading 0/N counts. `null` covers member-not-found OR a
 * compute failure. NOTE: a member whose plan grants NO metered benefits is
 * NOT `null` — it resolves to an empty array `[]` (`benefitsAvailable=true`,
 * `benefits=[]`); the page renders the same neutral copy via its own
 * `benefits.length > 0` guard, but the two states are distinct here.
 *
 * Pure interface — no framework imports (Constitution Principle III). The
 * `BenefitConsumptionEntry` shape is owned by the `load-renewal-summary`
 * use-case (single source of truth; also re-exported from the renewals
 * public barrel + consumed by the presentation component).
 */
import type { BenefitConsumptionEntry } from '../use-cases/load-renewal-summary';

export interface BenefitConsumptionReader {
  /**
   * Returns the member's metered benefit consumption, or `null` when
   * unavailable (member-not-found / compute error). An empty array means
   * "available, nothing metered" (distinct from `null`).
   * `null` → caller renders the neutral "unavailable" fallback.
   */
  read(
    tenantId: string,
    memberId: string,
  ): Promise<readonly BenefitConsumptionEntry[] | null>;
}
