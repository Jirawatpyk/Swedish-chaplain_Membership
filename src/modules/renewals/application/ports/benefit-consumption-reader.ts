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
 * instead of misleading 0/N counts. A `null` covers member-not-found, a
 * compute failure, or a member with no metered entitlements.
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
   * unavailable (member-not-found / compute error / no entitlements).
   * `null` → caller renders the neutral "unavailable" fallback.
   */
  read(
    tenantId: string,
    memberId: string,
  ): Promise<readonly BenefitConsumptionEntry[] | null>;
}
