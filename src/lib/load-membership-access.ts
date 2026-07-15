/**
 * 059-membership-suspension Task 9 — shared, request-cached membership-access
 * read for presentation surfaces that need the raw `full | suspended |
 * terminated` tri-state (as opposed to `checkPortalAccess`'s route-specific
 * allow/deny decision).
 *
 * Three call sites in this task share this ONE React `cache()`-wrapped
 * function with the same `(tenantId, memberId)` args:
 *   - `broadcasts/new/page.tsx` — page-level redirect for a suspended/
 *     terminated member (defense-in-depth alongside the use-case gate; the
 *     layout's `enforcePortalPageAccess` only re-runs on SSR load/refresh,
 *     NOT on client-side navigation between portal routes, so the page
 *     itself needs its own check too — same rationale as the pre-existing
 *     FR-009 `cap === 0` redirect it sits beside).
 *   - `benefits/page.tsx` — the "benefits paused" banner.
 *   - `member-command-palette-root.tsx` — filters the "Compose E-Blast" jump
 *     target (mounted globally in the member shell layout, so gating this on
 *     ITS OWN uncached read would double a DB round-trip on every portal
 *     page; sharing this cache means at most one extra read per request on
 *     top of the layout's own `checkPortalAccess` read — the same "two reads
 *     per request" shape the dashboard's `loadDashboardRenewalCycle` /
 *     `enforcePortalPageAccess` pair already accepts today).
 *
 * `src/lib/**` is the exempt composition layer (`eslint.config.mjs`), so
 * importing the renewals barrel here is allowed.
 *
 * Fails OPEN (`full`) on any read error — mirrors `checkPortalAccess`'s own
 * fail-open contract for the identical repo read. This helper is UX-only
 * (which page/section reflects which state); it is never the enforcement
 * boundary — the real gates are the layout chokepoint + the use-case
 * preconditions (F7 `submitBroadcast`, F3 `inviteColleague`).
 */
import { cache } from 'react';
import { logger } from '@/lib/logger';
import { loadLatestCycleForMember } from '@/lib/load-latest-cycle';
import {
  deriveMembershipAccess,
  type MembershipAccessDecision,
} from '@/modules/renewals';

const FAIL_OPEN_DECISION: MembershipAccessDecision = {
  access: 'full',
  reason: 'in_good_standing',
};

export const loadMembershipAccess = cache(
  async (tenantId: string, memberId: string): Promise<MembershipAccessDecision> => {
    try {
      // Shared with `enforcePortalPageAccess`'s layout read via the
      // request-cached `loadLatestCycleForMember` (one row read per SSR page
      // instead of two — see that helper's docstring).
      const cycle = await loadLatestCycleForMember(tenantId, memberId);
      return deriveMembershipAccess(cycle, new Date());
    } catch (e) {
      logger.warn(
        { tenantId, err: e instanceof Error ? e.message : String(e) },
        '[load-membership-access] findLatestCycleForMember failed — failing open to full',
      );
      return FAIL_OPEN_DECISION;
    }
  },
);
