/**
 * F8 renewal benefit-summary — insights-backed
 * `BenefitConsumptionReader` adapter.
 *
 * Implements the F8 `BenefitConsumptionReader` port by REUSING the F9
 * insights `computeBenefitUsage` use-case (barrel-only cross-module
 * import per Constitution Principle III — `@/modules/insights`). This is
 * the same source `/portal/benefits` consumes, so the renewal page and
 * the benefits page never drift.
 *
 * Mapping: insights `quantifiable` entries carry `{ key, used,
 * entitlement, lastUsedAt }`. The F8 `BenefitConsumptionEntry` shape is
 * `{ key, used, quota }`, so:
 *   - `cultural_tickets` → `cultural_ticket` (F8 key spelling)
 *   - `entitlement`      → `quota` (the annual cap)
 *   - `lastUsedAt`       → dropped (the renewal summary doesn't show it)
 *
 * insights `quantifiable` only ever yields `eblast` + `cultural_tickets`,
 * so the F8 `event_attendance` union member stays valid-but-unemitted
 * here (the renewal page tolerates it; future event-attendance quota
 * could populate it).
 *
 * Every failure mode collapses to `null` (the port's "unavailable"
 * signal): `computeBenefitUsage` returns `!ok` on member-not-found or a
 * compute error, and the use-case maps `null` → the neutral fallback.
 * No throw is needed — the use-case's own try/catch also guards, but
 * returning `null` is the documented contract.
 *
 * Pure Infrastructure — only the insights + tenants public barrels + the
 * F8 port type (Constitution Principle III).
 */
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
} from '@/modules/insights';
import { asTenantContext } from '@/modules/tenants';
import type { BenefitConsumptionReader } from '../../application/ports/benefit-consumption-reader';
import type { BenefitConsumptionEntry } from '../../application/use-cases/load-renewal-summary';

export const benefitConsumptionReaderInsights: BenefitConsumptionReader = {
  async read(tenantId, memberId) {
    const ctx = asTenantContext(tenantId);
    const result = await computeBenefitUsage(
      ctx,
      { memberId },
      makeComputeBenefitUsageDeps(tenantId),
    );
    if (!result.ok) {
      // member_not_found / compute_failed → unavailable.
      return null;
    }
    return result.value.quantifiable.map<BenefitConsumptionEntry>((q) => ({
      key: q.key === 'cultural_tickets' ? 'cultural_ticket' : 'eblast',
      used: q.used,
      quota: q.entitlement,
    }));
  },
};
