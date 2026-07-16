import { describe, it, expect } from 'vitest';
import {
  UNASSIGNED_TIER_KEY,
  groupActiveMembersByTier,
} from '@/modules/insights/domain/tier-distribution';
import type { MemberPlanRef } from '@/modules/insights/domain/quota-underuse';
import type { TierDistributionSlice } from '@/modules/insights/domain/dashboard-snapshot';

describe('groupActiveMembersByTier', () => {
  it('(a) groups two members with the same plan into one slice with count 2', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-a', planYear: 2026 },
    ];

    const labelOf = (planId: string) =>
      planId === 'plan-a' ? 'Corporate Tier' : null;

    const result = groupActiveMembersByTier(members, labelOf);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tierKey: 'plan-a',
      label: 'Corporate Tier',
      count: 2,
    });
  });

  it('(b) puts unresolved plans into unassigned bucket and sums to member count', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-b', planYear: 2026 },
      { memberId: 'm3', planId: 'plan-b', planYear: 2026 },
    ];

    // Only plan-a has a label; plan-b and others return null
    const labelOf = (planId: string) =>
      planId === 'plan-a' ? 'Corporate' : null;

    const result = groupActiveMembersByTier(members, labelOf);

    // Should have two slices: one for plan-a, one for unassigned (plan-b)
    expect(result).toHaveLength(2);

    // Sum of counts should equal member count
    const totalCount = result.reduce((sum, slice) => sum + slice.count, 0);
    expect(totalCount).toBe(members.length);

    // Find the unassigned slice
    const unassigned = result.find((s) => s.tierKey === UNASSIGNED_TIER_KEY);
    expect(unassigned).toBeDefined();
    expect(unassigned?.count).toBe(2); // Two members with unresolved plan-b
  });

  it('(c) sorts by count descending, then label ascending, with unassigned forced last', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm3', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm4', planId: 'plan-b', planYear: 2026 },
      { memberId: 'm5', planId: 'plan-b', planYear: 2026 },
      { memberId: 'm6', planId: 'plan-c', planYear: 2026 },
      { memberId: 'm7', planId: 'plan-d', planYear: 2026 }, // Will be unassigned
    ];

    const labelOf = (planId: string) => {
      switch (planId) {
        case 'plan-a':
          return 'Corporate';
        case 'plan-b':
          return 'Partnership';
        case 'plan-c':
          return 'Associate';
        default:
          return null; // plan-d is unresolved
      }
    };

    const result = groupActiveMembersByTier(members, labelOf);

    // Should have 4 slices: plan-a (3), plan-b (2), plan-c (1), unassigned (1)
    expect(result).toHaveLength(4);

    // Verify the order: desc by count, then asc by label, unassigned last
    expect(result[0]).toMatchObject({
      tierKey: 'plan-a',
      label: 'Corporate',
      count: 3,
    });
    expect(result[1]).toMatchObject({
      tierKey: 'plan-b',
      label: 'Partnership',
      count: 2,
    });
    expect(result[2]).toMatchObject({
      tierKey: 'plan-c',
      label: 'Associate',
      count: 1,
    });
    expect(result[3]).toMatchObject({
      tierKey: UNASSIGNED_TIER_KEY,
      label: UNASSIGNED_TIER_KEY,
      count: 1,
    });
  });

  it('(d) returns empty array for empty input', () => {
    const members: MemberPlanRef[] = [];

    const labelOf = (planId: string) => `Label for ${planId}`;

    const result = groupActiveMembersByTier(members, labelOf);

    expect(result).toEqual([]);
  });
});
