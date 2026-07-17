import type { LocaleText } from '@/modules/plans';
import type { MemberPlanRef } from './quota-underuse';
import type { TierDistributionSlice } from './dashboard-snapshot';

export const UNASSIGNED_TIER_KEY = 'unassigned';

/** Sentinel label for the unassigned bucket — presentation replaces it with a
 * translated string, so only the required `en` is set (never shown verbatim). */
const UNASSIGNED_LABEL: LocaleText = { en: UNASSIGNED_TIER_KEY };

/** GROUP active members by plan slug (plan year collapsed). A member whose plan
 * label can't resolve goes to `unassigned`, so the slices SUM to the active
 * count (the bars must never silently drop a member). Sorted count desc, then
 * label asc (by canonical EN — deterministic at compute time); `unassigned` is
 * forced last. */
export function groupActiveMembersByTier(
  members: readonly MemberPlanRef[],
  labelOf: (planId: string) => LocaleText | null,
): TierDistributionSlice[] {
  const byKey = new Map<string, { label: LocaleText; count: number }>();
  for (const m of members) {
    const label = labelOf(m.planId);
    const key = label === null ? UNASSIGNED_TIER_KEY : m.planId;
    const entry = byKey.get(key) ?? { label: label ?? UNASSIGNED_LABEL, count: 0 };
    entry.count += 1;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([tierKey, v]) => ({ tierKey, label: v.label, count: v.count }))
    .sort((a, b) => {
      if (a.tierKey === UNASSIGNED_TIER_KEY) return 1;
      if (b.tierKey === UNASSIGNED_TIER_KEY) return -1;
      // Tiebreak by the canonical EN name — deterministic in the cron (no
      // viewer locale); the client re-picks per locale for display, never re-sorts.
      return b.count - a.count || a.label.en.localeCompare(b.label.en);
    });
}
