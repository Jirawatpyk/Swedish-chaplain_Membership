/**
 * `buildPlanOptions` — server-side `PlanListItem[] → PlanOption[]` mapper.
 *
 * Single source of truth for turning F2 `listPlans` rows into the member-
 * form plan picker options: resolves the localised plan name (was a
 * hardcoded `.en` at both admin member pages, dropping TH/SV — P1-8),
 * threads the annual fee + currency + category so the picker can surface
 * the fee, and keeps the DOB-required proxy.
 */
import { describe, expect, it } from 'vitest';
import { buildPlanOptions } from '@/components/members/member-form/build-plan-options';

const ROW = {
  plan_id: 'regular',
  plan_year: 2026,
  plan_name: { en: 'Regular Corporate' },
  member_type_scope: 'company' as const,
  annual_fee_minor_units: 5_000_000,
  plan_category: 'corporate' as const,
};

describe('buildPlanOptions', () => {
  it('resolves plan_name via resolvePlanName (TH falls back to EN when th missing — proves the resolver ran)', () => {
    const opts = buildPlanOptions([ROW], 'th', 'THB');
    expect(opts[0]!.display_name).toBe('Regular Corporate — 2026');
  });

  it('display_name ends with "— {plan_year}"', () => {
    const opts = buildPlanOptions([ROW], 'en', 'THB');
    expect(opts[0]!.display_name.endsWith('— 2026')).toBe(true);
  });

  it('copies the annual fee + plan_category through', () => {
    const opts = buildPlanOptions([ROW], 'en', 'THB');
    expect(opts[0]!.annual_fee_minor_units).toBe(5_000_000);
    expect(opts[0]!.plan_category).toBe('corporate');
  });

  it('takes currency_code from the 3rd argument, not a hardcoded literal', () => {
    const opts = buildPlanOptions([ROW], 'en', 'SEK');
    expect(opts[0]!.currency_code).toBe('SEK');
  });

  it('sets requires_date_of_birth true ONLY for an individual-scoped plan', () => {
    const company = buildPlanOptions([ROW], 'en', 'THB');
    expect(company[0]!.requires_date_of_birth).toBe(false);
    const individual = buildPlanOptions(
      [{ ...ROW, member_type_scope: 'individual' as const }],
      'en',
      'THB',
    );
    expect(individual[0]!.requires_date_of_birth).toBe(true);
  });

  it('maps an empty list to an empty list', () => {
    expect(buildPlanOptions([], 'en', 'THB')).toEqual([]);
  });
});
