import { describe, it, expect } from 'vitest';
import {
  UNASSIGNED_TIER_KEY,
  groupActiveMembersByTier,
} from '@/modules/insights/domain/tier-distribution';
import type { MemberPlanRef } from '@/modules/insights/domain/quota-underuse';

describe('groupActiveMembersByTier', () => {
  // Drift guard for `membership-tier-chart.tsx`'s client-side literal
  // `s.tierKey === 'unassigned'` (a client component cannot runtime-import
  // this domain barrel — see that file's comment). Pins the constant's
  // actual VALUE, not just its identity, so the literal can't silently go
  // stale if `UNASSIGNED_TIER_KEY` is ever renamed.
  it('UNASSIGNED_TIER_KEY is the literal "unassigned" the client component compares against', () => {
    expect(UNASSIGNED_TIER_KEY).toBe('unassigned');
  });

  it('(a) groups two members with the same plan into one slice with count 2', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-a', planYear: 2026 },
    ];

    const labelOf = (planId: string) =>
      planId === 'plan-a' ? { en: 'Corporate Tier' } : null;

    const result = groupActiveMembersByTier(members, labelOf);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tierKey: 'plan-a',
      label: { en: 'Corporate Tier' },
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
      planId === 'plan-a' ? { en: 'Corporate' } : null;

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
          return { en: 'Corporate' };
        case 'plan-b':
          return { en: 'Partnership' };
        case 'plan-c':
          return { en: 'Associate' };
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
      label: { en: 'Corporate' },
      count: 3,
    });
    expect(result[1]).toMatchObject({
      tierKey: 'plan-b',
      label: { en: 'Partnership' },
      count: 2,
    });
    expect(result[2]).toMatchObject({
      tierKey: 'plan-c',
      label: { en: 'Associate' },
      count: 1,
    });
    expect(result[3]).toMatchObject({
      tierKey: UNASSIGNED_TIER_KEY,
      label: { en: UNASSIGNED_TIER_KEY },
      count: 1,
    });
  });

  it('(d) returns empty array for empty input', () => {
    const members: MemberPlanRef[] = [];

    const labelOf = (planId: string) => ({ en: `Label for ${planId}` });

    const result = groupActiveMembersByTier(members, labelOf);

    expect(result).toEqual([]);
  });

  it('(e) collapses two members with different unresolved planIds into a single unassigned slice', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-b', planYear: 2026 },
      { memberId: 'm2', planId: 'plan-c', planYear: 2026 },
    ];

    // Both plan-b and plan-c return null (unresolved)
    const labelOf = (_planId: string): { en: string } | null => null;

    const result = groupActiveMembersByTier(members, labelOf);

    // Should have exactly one unassigned slice
    expect(result).toHaveLength(1);

    const unassigned = result[0]!;
    expect(unassigned.tierKey).toBe(UNASSIGNED_TIER_KEY);
    expect(unassigned.count).toBe(2);
  });

  it('(f) picks each slice label from the resolved LocaleText (all locales preserved)', () => {
    const members: MemberPlanRef[] = [
      { memberId: 'm1', planId: 'plan-a', planYear: 2026 },
    ];

    const labelOf = (planId: string) =>
      planId === 'plan-a'
        ? { en: 'Regular Corporate', th: 'สมาชิกองค์กรทั่วไป', sv: 'Vanlig företagsmedlem' }
        : null;

    const result = groupActiveMembersByTier(members, labelOf);

    // The full LocaleText round-trips into the slice so presentation can pick
    // the viewer's locale (never lossily flattened to EN at compute time).
    expect(result[0]?.label).toEqual({
      en: 'Regular Corporate',
      th: 'สมาชิกองค์กรทั่วไป',
      sv: 'Vanlig företagsmedlem',
    });
  });
});
