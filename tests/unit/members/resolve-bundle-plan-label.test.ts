/**
 * WP7 (BP5 item 6 + C-16) — `resolveBundlePlanLabel`.
 *
 * Exact (plan_id, plan_year) match; a same-id/different-year plan does NOT
 * resolve (→ caller falls back to the font-mono id).
 */
import { describe, expect, it } from 'vitest';
import { resolveBundlePlanLabel } from '@/components/members/resolve-bundle-plan-label';
import type { PlanOption } from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  { plan_id: 'corp-a', plan_year: 2026, display_name: 'Corporate A — 2026' },
  { plan_id: 'corp-b', plan_year: 2027, display_name: 'Corporate B — 2027' },
];

describe('resolveBundlePlanLabel', () => {
  it('returns the display name on an exact (id, year) match', () => {
    expect(resolveBundlePlanLabel(PLANS, 'corp-a', 2026)).toBe(
      'Corporate A — 2026',
    );
  });

  it('returns null when the id exists only under a different year', () => {
    expect(resolveBundlePlanLabel(PLANS, 'corp-a', 2027)).toBeNull();
  });

  it('returns null for a null id', () => {
    expect(resolveBundlePlanLabel(PLANS, null, 2026)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(resolveBundlePlanLabel(PLANS, 'nope', 2026)).toBeNull();
  });
});
