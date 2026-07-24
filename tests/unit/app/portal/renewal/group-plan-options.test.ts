/**
 * WP3 — `groupPlanOptions` pure partition helper.
 *
 * Partitions the portal renewal plan options into upgrade / current /
 * downgrade buckets (feeds the grouped <SelectGroup> blocks). A same-priced
 * non-current alternative (rare — the catalogue prices are distinct) is NOT
 * a downgrade, so it groups with the higher-priced ("upgrade") bucket; the
 * downgrade bucket holds exactly the plans that trigger a downgrade ack.
 */
import { describe, expect, it } from 'vitest';
import { groupPlanOptions } from '@/app/(member)/portal/renewal/[memberId]/_lib/group-plan-options';

const P = (planId: string, annualFeeMinorUnits: number) => ({
  planId,
  annualFeeMinorUnits,
});

// a: downgrade (3M<5M) · current · b: same price 5M non-current (→ upgrade) · c: upgrade (8M)
const PLANS = [P('a', 3_000_000), P('current', 5_000_000), P('b', 5_000_000), P('c', 8_000_000)];

const grouped = groupPlanOptions({
  plans: PLANS,
  currentPlanId: 'current',
  currentPriceMinorUnits: 5_000_000,
});

describe('groupPlanOptions', () => {
  it('partitions exhaustively — upgrade + current + downgrade === input.length', () => {
    expect(
      grouped.upgrade.length + grouped.current.length + grouped.downgrade.length,
    ).toBe(PLANS.length);
  });

  it('never places a plan id in two groups', () => {
    const ids = [
      ...grouped.upgrade,
      ...grouped.current,
      ...grouped.downgrade,
    ].map((p) => p.planId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('always lands the current plan id in the current group', () => {
    expect(grouped.current.map((p) => p.planId)).toEqual(['current']);
  });

  it('preserves input order within each group', () => {
    expect(grouped.downgrade.map((p) => p.planId)).toEqual(['a']);
    expect(grouped.upgrade.map((p) => p.planId)).toEqual(['b', 'c']);
  });
});
