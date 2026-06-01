/**
 * Unit — countUnderUsedQuota (go-live P1-4 / FR-004 cross-member quota insights).
 *
 * The dashboard cards `unused_eblast_quota` + `underused_event_tickets` count
 * the number of ACTIVE members whose consumption of a quantifiable benefit is
 * below their plan entitlement for the membership year. Threshold = "any
 * shortfall" (used < entitlement, entitlement > 0) — distinct from the FR-021
 * US4 member-view 25pt-gap rule (decision locked 2026-06-01). The headline
 * `underDeliveredEither` is the de-duped UNION of members short on EITHER benefit.
 *
 * Pure domain — table-driven, no framework.
 */
import { describe, it, expect } from 'vitest';
import {
  countUnderUsedQuota,
  planKey,
  type MemberPlanRef,
  type QuotaEntitlement,
} from '@/modules/insights/domain/quota-underuse';

const PLAN_A = { planId: 'corporate-gold', planYear: 2026 };
const PLAN_ZERO = { planId: 'partner-basic', planYear: 2026 };

function member(memberId: string, plan = PLAN_A): MemberPlanRef {
  return { memberId, planId: plan.planId, planYear: plan.planYear };
}

const ENT_A: QuotaEntitlement = { eblastPerYear: 12, culturalTicketsPerYear: 4 };
const ENT_ZERO: QuotaEntitlement = { eblastPerYear: 0, culturalTicketsPerYear: 2 };

function entMap(
  entries: ReadonlyArray<readonly [{ planId: string; planYear: number }, QuotaEntitlement]>,
): ReadonlyMap<string, QuotaEntitlement> {
  return new Map(entries.map(([p, e]) => [planKey(p.planId, p.planYear), e]));
}

describe('planKey', () => {
  it('is stable + collision-free for distinct (planId, planYear)', () => {
    expect(planKey('a', 2026)).toBe('a::2026');
    expect(planKey('a', 2026)).not.toBe(planKey('a', 2025));
    expect(planKey('a', 2026)).not.toBe(planKey('b', 2026));
  });
});

describe('countUnderUsedQuota (FR-004 — any-shortfall rule)', () => {
  it('empty member list → all zeros', () => {
    const r = countUnderUsedQuota({
      members: [],
      eblastUsedByMember: new Map(),
      culturalUsedByMember: new Map(),
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r).toEqual({
      unusedEblastMembers: 0,
      underusedTicketMembers: 0,
      underDeliveredEither: 0,
    });
  });

  it('used < entitlement → counted for that benefit', () => {
    const r = countUnderUsedQuota({
      members: [member('m1')],
      eblastUsedByMember: new Map([['m1', 3]]), // 3 < 12 → unused eblast
      culturalUsedByMember: new Map([['m1', 1]]), // 1 < 4 → underused tickets
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r.unusedEblastMembers).toBe(1);
    expect(r.underusedTicketMembers).toBe(1);
    expect(r.underDeliveredEither).toBe(1);
  });

  it('used === entitlement → NOT counted (fully consumed)', () => {
    const r = countUnderUsedQuota({
      members: [member('m1')],
      eblastUsedByMember: new Map([['m1', 12]]),
      culturalUsedByMember: new Map([['m1', 4]]),
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r.unusedEblastMembers).toBe(0);
    expect(r.underusedTicketMembers).toBe(0);
    expect(r.underDeliveredEither).toBe(0);
  });

  it('used > entitlement → NOT counted (over-consumed; never negative shortfall)', () => {
    const r = countUnderUsedQuota({
      members: [member('m1')],
      eblastUsedByMember: new Map([['m1', 20]]),
      culturalUsedByMember: new Map([['m1', 9]]),
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r.unusedEblastMembers).toBe(0);
    expect(r.underusedTicketMembers).toBe(0);
    expect(r.underDeliveredEither).toBe(0);
  });

  it('member absent from the used-map → treated as used=0 → counted when entitlement > 0', () => {
    const r = countUnderUsedQuota({
      members: [member('m1')],
      eblastUsedByMember: new Map(), // absent → 0
      culturalUsedByMember: new Map(), // absent → 0
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r.unusedEblastMembers).toBe(1);
    expect(r.underusedTicketMembers).toBe(1);
    expect(r.underDeliveredEither).toBe(1);
  });

  it('entitlement = 0 for a benefit → member excluded from THAT benefit (not-applicable)', () => {
    const r = countUnderUsedQuota({
      members: [member('m1', PLAN_ZERO)],
      eblastUsedByMember: new Map(), // 0 used, but eblast entitlement is 0
      culturalUsedByMember: new Map([['m1', 1]]), // 1 < 2 → underused tickets
      entitlementByPlanKey: entMap([[PLAN_ZERO, ENT_ZERO]]),
    });
    expect(r.unusedEblastMembers).toBe(0); // eblast entitlement 0 → not counted
    expect(r.underusedTicketMembers).toBe(1);
    expect(r.underDeliveredEither).toBe(1);
  });

  it('member whose plan entitlement is missing from the map → excluded entirely', () => {
    const r = countUnderUsedQuota({
      members: [member('m1', { planId: 'unknown', planYear: 2026 })],
      eblastUsedByMember: new Map(),
      culturalUsedByMember: new Map(),
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]), // no entry for 'unknown'
    });
    expect(r.unusedEblastMembers).toBe(0);
    expect(r.underusedTicketMembers).toBe(0);
    expect(r.underDeliveredEither).toBe(0);
  });

  it('underDeliveredEither is the de-duped UNION across both benefits', () => {
    const r = countUnderUsedQuota({
      members: [member('eblastOnly'), member('cultOnly'), member('both'), member('neither')],
      eblastUsedByMember: new Map([
        ['eblastOnly', 0], // under eblast
        ['cultOnly', 12], // eblast full
        ['both', 1], // under eblast
        ['neither', 12], // eblast full
      ]),
      culturalUsedByMember: new Map([
        ['eblastOnly', 4], // cultural full
        ['cultOnly', 0], // under cultural
        ['both', 0], // under cultural
        ['neither', 4], // cultural full
      ]),
      entitlementByPlanKey: entMap([[PLAN_A, ENT_A]]),
    });
    expect(r.unusedEblastMembers).toBe(2); // eblastOnly, both
    expect(r.underusedTicketMembers).toBe(2); // cultOnly, both
    expect(r.underDeliveredEither).toBe(3); // eblastOnly ∪ cultOnly ∪ both (neither excluded)
  });
});
