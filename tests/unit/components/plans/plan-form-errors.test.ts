// tests/unit/components/plans/plan-form-errors.test.ts
//
// Maps `planSchema` issues to a per-field message key + the wizard step that
// owns the field, including the cross-field rules in plan-validators.ts.

import { describe, it, expect } from 'vitest';
import { planFormFieldErrors, planFieldStep } from '@/components/plans/plan-form-errors';
import type { PlanSchemaInput } from '@/modules/plans';

const VALID: PlanSchemaInput = {
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

describe('planFormFieldErrors', () => {
  it('is empty for a valid draft', () => {
    expect(planFormFieldErrors(VALID)).toEqual({});
  });

  it('maps min >= max turnover onto max turnover', () => {
    expect(
      planFormFieldErrors({
        ...VALID,
        min_turnover_minor_units: 200,
        max_turnover_minor_units: 200,
      }),
    ).toEqual({ max_turnover_minor_units: 'turnoverOrder' });
  });

  it('requires a bundled corporate plan and the partnership matrix on partnership plans', () => {
    expect(planFormFieldErrors({ ...VALID, plan_category: 'partnership' })).toEqual({
      includes_corporate_plan_id: 'bundleRequired',
      benefit_matrix: 'partnershipBenefits',
    });
  });

  it('refuses a bundle on a corporate plan', () => {
    expect(
      planFormFieldErrors({ ...VALID, includes_corporate_plan_id: 'gold' }),
    ).toEqual({ includes_corporate_plan_id: 'bundleNotAllowed' });
  });

  it('maps plain field issues to their own keys', () => {
    expect(
      planFormFieldErrors({
        ...VALID,
        plan_id: '',
        plan_year: 1999,
        plan_name: { en: ' ' },
        description: { en: '' },
        sort_order: -1,
        annual_fee_minor_units: -1,
        min_turnover_minor_units: 1.5,
        max_member_age: 500,
        max_duration_years: 0,
      }),
    ).toEqual({
      plan_id: 'planId',
      plan_year: 'planYear',
      plan_name: 'planName',
      description: 'description',
      sort_order: 'sortOrder',
      annual_fee_minor_units: 'annualFee',
      min_turnover_minor_units: 'amount',
      max_member_age: 'maxMemberAge',
      max_duration_years: 'maxDurationYears',
    });
  });
});

describe('planFieldStep', () => {
  it('assigns fields to the wizard step that renders them', () => {
    expect(planFieldStep('plan_id')).toBe('basics');
    expect(planFieldStep('max_turnover_minor_units')).toBe('fees');
    expect(planFieldStep('includes_corporate_plan_id')).toBe('fees');
    expect(planFieldStep('benefit_matrix')).toBe('benefits');
  });
});
