// tests/unit/components/plans/plan-patch.test.ts
//
// The edit page sends only the fields that changed (`computePlanPatch`) and
// validates that sparse patch with `planPatchSchema` before sending
// (`planPatchFieldErrors`), mapped to the wizard's per-field message keys.

import { describe, it, expect } from 'vitest';
import { computePlanPatch, planPatchFieldErrors } from '@/components/plans/plan-patch';
import type { PlanSchemaInput } from '@/modules/plans';

const PLAN: PlanSchemaInput = {
  plan_id: 'diamond',
  plan_year: 2026,
  plan_name: { en: 'Diamond' },
  description: { en: 'Top tier' },
  sort_order: 10,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: {
    eblast_per_year: 0,
    website_page_type: null,
    homepage_logo_category: null,
    directory_listing_size: null,
    event_discount_scope: 'none',
    events_cobranded_access: false,
    cultural_tickets_per_year: 0,
    m2m_benefits_access: false,
    business_referrals: false,
    tailor_made_services: false,
    partnership: null,
  },
};

describe('computePlanPatch', () => {
  it('is empty when nothing changed', () => {
    expect(computePlanPatch(PLAN, { ...PLAN })).toEqual({});
  });

  it('keeps only the changed fields', () => {
    const draft: PlanSchemaInput = {
      ...PLAN,
      sort_order: 20,
      plan_name: { en: 'Diamond', th: 'ไดมอนด์' },
      benefit_matrix: { ...PLAN.benefit_matrix, eblast_per_year: 4 },
    };
    expect(computePlanPatch(PLAN, draft)).toEqual({
      sort_order: 20,
      plan_name: { en: 'Diamond', th: 'ไดมอนด์' },
      benefit_matrix: { ...PLAN.benefit_matrix, eblast_per_year: 4 },
    });
  });

  it('never patches the identity keys', () => {
    const draft: PlanSchemaInput = { ...PLAN, plan_id: 'other', plan_year: 2027 };
    expect(computePlanPatch(PLAN, draft)).toEqual({});
  });

  it('sends a cleared nullable field as null', () => {
    const initial: PlanSchemaInput = { ...PLAN, max_member_age: 40 };
    expect(computePlanPatch(initial, PLAN)).toEqual({ max_member_age: null });
  });
});

describe('planPatchFieldErrors', () => {
  it('is empty for a valid patch', () => {
    expect(planPatchFieldErrors({ sort_order: 20 }, 'corporate')).toEqual({});
    expect(planPatchFieldErrors({}, 'corporate')).toEqual({});
  });

  it('maps shape errors to the field message keys', () => {
    expect(
      planPatchFieldErrors(
        { sort_order: 20_000, plan_name: { en: '' }, max_member_age: 250 },
        'corporate',
      ),
    ).toEqual({ sort_order: 'sortOrder', plan_name: 'planName', max_member_age: 'maxMemberAge' });
  });

  it('maps the turnover-order rule to the maximum turnover', () => {
    expect(
      planPatchFieldErrors(
        { min_turnover_minor_units: 500, max_turnover_minor_units: 100 },
        'corporate',
      ),
    ).toEqual({ max_turnover_minor_units: 'turnoverOrder' });
  });

  it('maps the bundle rules by plan category', () => {
    expect(
      planPatchFieldErrors(
        { plan_category: 'partnership', includes_corporate_plan_id: null },
        'partnership',
      ),
    ).toEqual({ includes_corporate_plan_id: 'bundleRequired' });
    expect(
      planPatchFieldErrors(
        { plan_category: 'corporate', includes_corporate_plan_id: 'gold' },
        'corporate',
      ),
    ).toEqual({ includes_corporate_plan_id: 'bundleNotAllowed' });
  });
});
