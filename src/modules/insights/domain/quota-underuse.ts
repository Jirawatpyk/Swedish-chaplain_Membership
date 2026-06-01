/**
 * F9 quota under-use roll-up (go-live P1-4 / FR-004).
 *
 * Pure domain rule behind the two dashboard cards `unused_eblast_quota` +
 * `underused_event_tickets`. Given the active members (with their plan ref),
 * each member's consumption of the two quantifiable benefits, and the plan
 * entitlements keyed by (planId, planYear), it counts:
 *   - unusedEblastMembers     — members short on E-Blast quota
 *   - underusedTicketMembers  — members short on cultural/event tickets
 *   - underDeliveredEither    — de-duped UNION of members short on EITHER (the
 *                               `underDeliveredBenefitCount` headline KPI)
 *
 * THRESHOLD = "any shortfall": a member counts for a benefit iff the plan
 * grants a positive entitlement AND the member has used strictly fewer than
 * that entitlement this membership year (`used < entitlement`). This is
 * INTENTIONALLY DIFFERENT from the FR-021 US4 member-view rule (25pt-gap
 * mean-of-ratios "behind year-pace"): the card answers "who still has unused
 * quota?", the member view answers "who is statistically under-paced?". A
 * member who used 11/12 E-Blasts therefore counts here (1 unused) but not in
 * the 25pt-gap US4 view. Decision locked with the product owner 2026-06-01.
 *
 * Members whose plan entitlement is absent from the map (plan/year not found)
 * are EXCLUDED — we cannot assert under-use without an entitlement baseline.
 * A benefit with entitlement 0 is "not applicable" for that member, never
 * "under-used". `used > entitlement` (over-consumption) is not a shortfall.
 *
 * Pure Domain — no framework/ORM imports.
 */

/** A member's plan identity for the membership year (entitlement lookup key parts). */
export interface MemberPlanRef {
  readonly memberId: string;
  readonly planId: string;
  readonly planYear: number;
}

/** The two quantifiable per-year entitlements the cards measure. */
export interface QuotaEntitlement {
  readonly eblastPerYear: number;
  readonly culturalTicketsPerYear: number;
}

export interface QuotaUnderUseRollup {
  readonly unusedEblastMembers: number;
  readonly underusedTicketMembers: number;
  readonly underDeliveredEither: number;
}

export interface CountUnderUsedQuotaInput {
  readonly members: readonly MemberPlanRef[];
  /** memberId → E-Blasts sent this membership year. Absent key ⇒ 0. */
  readonly eblastUsedByMember: ReadonlyMap<string, number>;
  /** memberId → cultural tickets used this membership year. Absent key ⇒ 0. */
  readonly culturalUsedByMember: ReadonlyMap<string, number>;
  /** planKey(planId, planYear) → entitlements. Absent ⇒ member excluded. */
  readonly entitlementByPlanKey: ReadonlyMap<string, QuotaEntitlement>;
}

/**
 * Single source of truth for the entitlement-map key. Used by BOTH the
 * application use-case (which builds the map) and this domain roll-up (which
 * reads it) so the two never drift. Domain-owned because the domain function
 * consumes it; the application layer imports it.
 */
export function planKey(planId: string, planYear: number): string {
  return `${planId}::${planYear}`;
}

export function countUnderUsedQuota(
  input: CountUnderUsedQuotaInput,
): QuotaUnderUseRollup {
  let unusedEblastMembers = 0;
  let underusedTicketMembers = 0;
  const underDelivered = new Set<string>();

  for (const m of input.members) {
    const entitlement = input.entitlementByPlanKey.get(
      planKey(m.planId, m.planYear),
    );
    // No entitlement baseline → cannot assess under-use → exclude.
    if (entitlement === undefined) continue;

    const eblastUsed = input.eblastUsedByMember.get(m.memberId) ?? 0;
    const culturalUsed = input.culturalUsedByMember.get(m.memberId) ?? 0;

    const eblastUnder =
      entitlement.eblastPerYear > 0 && eblastUsed < entitlement.eblastPerYear;
    const culturalUnder =
      entitlement.culturalTicketsPerYear > 0 &&
      culturalUsed < entitlement.culturalTicketsPerYear;

    if (eblastUnder) unusedEblastMembers += 1;
    if (culturalUnder) underusedTicketMembers += 1;
    if (eblastUnder || culturalUnder) underDelivered.add(m.memberId);
  }

  return {
    unusedEblastMembers,
    underusedTicketMembers,
    underDeliveredEither: underDelivered.size,
  };
}
