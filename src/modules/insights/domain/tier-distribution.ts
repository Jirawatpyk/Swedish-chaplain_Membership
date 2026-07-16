import type { MemberPlanRef } from './quota-underuse';
import type { TierDistributionSlice } from './dashboard-snapshot';

export const UNASSIGNED_TIER_KEY = 'unassigned';

/** GROUP active members by plan slug (plan year collapsed). A member whose plan
 * label can't resolve goes to `unassigned`, so the slices SUM to the active
 * count (the bars must never silently drop a member). Sorted count desc, then
 * label asc; `unassigned` is forced last. */
export function groupActiveMembersByTier(
  members: readonly MemberPlanRef[],
  labelOf: (planId: string) => string | null,
): TierDistributionSlice[] {
  const byKey = new Map<string, { label: string; count: number }>();
  for (const m of members) {
    const label = labelOf(m.planId);
    const key = label === null ? UNASSIGNED_TIER_KEY : m.planId;
    const entry = byKey.get(key) ?? { label: label ?? UNASSIGNED_TIER_KEY, count: 0 };
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([tierKey, v]) => ({ tierKey, label: v.label, count: v.count }))
    .sort((a, b) => {
      if (a.tierKey === UNASSIGNED_TIER_KEY) return 1;
      if (b.tierKey === UNASSIGNED_TIER_KEY) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
}
