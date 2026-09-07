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
  type QuantifiableBenefitKey,
} from '@/modules/insights';
import { asTenantContext } from '@/modules/tenants';
import type { BenefitConsumptionReader } from '../../application/ports/benefit-consumption-reader';
import type { BenefitConsumptionEntry } from '../../application/use-cases/load-renewal-summary';

/**
 * Exhaustive insights→F8 key map. The `never` default means a NEW insights
 * `QuantifiableBenefitKey` fails the BUILD here instead of silently
 * mis-mapping to 'eblast' — a binary `=== 'cultural_tickets' ? … : 'eblast'`
 * ternary would mis-route any future third key (review: type-design #1).
 */
function mapQuantifiableKey(
  key: QuantifiableBenefitKey,
):
  | Extract<BenefitConsumptionEntry['key'], 'eblast' | 'cultural_ticket'>
  // 2026-09-07 — see the default arm.
  | null {
  switch (key) {
    case 'eblast':
      return 'eblast';
    case 'cultural_tickets':
      return 'cultural_ticket';
    default: {
      const _exhaustive: never = key;
      // The docblock above says this arm stops a new key "silently
      // mis-mapping to 'eblast'". `return _exhaustive` returned the KEY
      // STRING, which the caller then wrote straight into a
      // `BenefitConsumptionEntry.key` position — so the entry carried a name
      // this build cannot resolve, and the member's renewal summary showed a
      // consumption figure attributed to a benefit nobody could name. Every
      // member of the target union asserts WHICH benefit was consumed, so
      // there is no safe substitute: the honest answer is to emit no entry.
      // The caller drops it (see `read`).
      void _exhaustive;
      return null;
    }
  }
}

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
    // `flatMap`, not `map`: a key this build cannot name yields no entry at
    // all rather than one attributed to the wrong benefit (2026-09-07).
    return result.value.quantifiable.flatMap<BenefitConsumptionEntry>((q) => {
      const key = mapQuantifiableKey(q.key);
      if (key === null) return [];
      return [{ key, used: q.used, quota: q.entitlement }];
    });
  },
};
