import { describe, it, expect } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

/**
 * Locks the portal.dashboard i18n surface for the live primitives across
 * all three locales. Missing keys would surface as raw key paths in the
 * UI (EN) or fail `pnpm check:i18n` on release branches (TH/SV).
 *
 * D1 review finding A1 — this list is now the FULL set of every key the three
 * stat sections + the Dashboard page actually render (grep'd from the source),
 * not just the review-touched subset. A future key rename that misses a
 * consumer fails the build here (parity) AND the per-section render tests in
 * dashboard-stat-sections.test.tsx (resolution against the real en.json) —
 * closing the MISSING_MESSAGE-at-runtime class that has bitten this project
 * twice. Keep this list in lockstep with the rendered keys when editing a
 * section.
 *
 * Keys removed from this list (catch-up review 2026-06-06):
 *  - quotaBar.readout / quotaBar.ariaLabel  (dead: QuotaBar component deleted)
 *  - activity.empty.body  (dead: portal ActivityFeed primitive deleted;
 *    RecentActivitySection uses only empty.title + emptyCta)
 */
const REQUIRED = [
  // --- page.tsx (namespace portal.dashboard) -----------------------------
  'welcome',
  'intro',
  'statusChip.active',
  'statusChip.inactive',
  'statusChip.archived',
  'firstRun.title',
  'firstRun.body',
  'firstRun.exploreBenefits',
  // --- recent-activity-section.tsx ---------------------------------------
  'activity.title',
  'activity.empty.title',
  'activity.emptyCta',
  'activity.viewAll',
  'activity.loadFailed', // D1 finding B2 — distinct read-failure state.
  // --- membership-stat-section.tsx ---------------------------------------
  'membership.label',
  'membership.activeValue',
  'membership.activeSub',
  'membership.renewDueValue',
  'membership.renewUpcomingValue',
  'membership.daysRemainingSub',
  'membership.overdueValue',
  'membership.overdueSub',
  'membership.lapsedValue',
  'membership.lapsedSub',
  'membership.emptyValue',
  'membership.emptySub',
  'membership.errorValue',
  'membership.errorSub',
  // --- outstanding-stat-section.tsx --------------------------------------
  'outstanding.label',
  'outstanding.value',
  'outstanding.valuePartial',
  'outstanding.countSub',
  'outstanding.countSubPartial',
  'outstanding.dueSub',
  'outstanding.overdueSub',
  'outstanding.overdueSubPartial',
  'outstanding.clearValue',
  'outstanding.clearSub',
  'outstanding.errorValue',
  'outstanding.errorSub',
  // --- benefits-stat-section.tsx -----------------------------------------
  'benefits.label',
  'benefits.underUseValue',
  'benefits.underUseSub',
  'benefits.onTrackValue',
  'benefits.onTrackSub',
  'benefits.emptyValue',
  'benefits.emptySub',
  'benefits.errorValue',
  'benefits.errorSub',
] as const;

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      obj,
    );
}

describe('portal.dashboard i18n keys', () => {
  for (const [name, msgs] of [
    ['en', en],
    ['th', th],
    ['sv', sv],
  ] as const) {
    for (const key of REQUIRED) {
      it(`${name}: portal.dashboard.${key} is a non-empty string`, () => {
        const v = get(
          (msgs as Record<string, unknown>).portal,
          `dashboard.${key}`,
        );
        expect(typeof v).toBe('string');
        expect((v as string).length).toBeGreaterThan(0);
      });
    }
  }
});
