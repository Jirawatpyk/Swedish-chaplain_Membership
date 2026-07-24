/**
 * WP7 — `buildPlanChangeSummary` + `formatPlanFee` (BP3 + correction C-16).
 *
 * Pins the (plan_id, plan_year) lookup (an id-only match would fabricate the
 * wrong-year fee on a money screen), the absent-old-plan fallback (null fee,
 * never borrowing the new fee), the zero-vs-em-dash fee distinction, the
 * non-integer BigInt guard, and the billing-flow flag.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlanChangeSummary,
  formatPlanFee,
  PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL,
} from '@/components/members/plan-change-summary';
import type { PlanOption } from '@/components/members/member-form';

const PLANS: PlanOption[] = [
  {
    plan_id: 'premium',
    plan_year: 2026,
    display_name: 'Premium — 2026',
    annual_fee_minor_units: 5_000_000,
    currency_code: 'THB',
    plan_category: 'corporate',
  },
  {
    plan_id: 'regular',
    plan_year: 2026,
    display_name: 'Regular — 2026',
    annual_fee_minor_units: 3_000_000,
    currency_code: 'THB',
    plan_category: 'corporate',
  },
  {
    plan_id: 'premium',
    plan_year: 2027,
    display_name: 'Premium — 2027',
    annual_fee_minor_units: 5_500_000,
    currency_code: 'THB',
    plan_category: 'corporate',
  },
];

describe('buildPlanChangeSummary', () => {
  it('matches on (plan_id, plan_year), not id alone', () => {
    const s = buildPlanChangeSummary(PLANS, 'premium', 2026, 'premium', 2027);
    expect(s.oldFeeMinorUnits).toBe(5_000_000); // the 2026 fee
    expect(s.newFeeMinorUnits).toBe(5_500_000); // the 2027 fee, NOT the 2026 one
    expect(s.oldPlanLabel).toBe('Premium — 2026');
    expect(s.newPlanLabel).toBe('Premium — 2027');
    expect(s.yearOnly).toBe(true);
  });

  it('resolves a cross-tier change (yearOnly=false)', () => {
    const s = buildPlanChangeSummary(PLANS, 'premium', 2026, 'regular', 2026);
    expect(s.oldFeeMinorUnits).toBe(5_000_000);
    expect(s.newFeeMinorUnits).toBe(3_000_000);
    expect(s.yearOnly).toBe(false);
  });

  it('falls back to the slug + null fee for an absent old plan, never borrowing the new fee', () => {
    const s = buildPlanChangeSummary(PLANS, 'legacy', 2020, 'regular', 2026);
    expect(s.oldPlanLabel).toBe('legacy'); // slug fallback
    expect(s.oldFeeMinorUnits).toBeNull();
    expect(s.newFeeMinorUnits).toBe(3_000_000); // not copied onto the old side
    expect(s.currencyCode).toBe('THB'); // currency still resolvable from the new plan
  });
});

describe('formatPlanFee', () => {
  it('formats a zero fee as money, not em-dash', () => {
    const out = formatPlanFee(0, 'en', 'THB');
    expect(out).not.toBe('—');
    expect(out).toContain('0.00');
  });

  it('formats a normal fee with grouping', () => {
    expect(formatPlanFee(5_000_000, 'en', 'THB')).toContain('50,000.00');
  });

  it('guards a non-integer minor-units value (BigInt would throw)', () => {
    expect(() => formatPlanFee(1.5, 'en', 'THB')).not.toThrow();
    expect(formatPlanFee(1.5, 'en', 'THB')).toBe('—');
  });
});

describe('PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL', () => {
  it('is true — the seed now reads members.plan_id, so future renewal cycles bill the new plan', () => {
    expect(PLAN_CHANGE_BILLING_FLOWS_TO_RENEWAL).toBe(true);
  });
});
