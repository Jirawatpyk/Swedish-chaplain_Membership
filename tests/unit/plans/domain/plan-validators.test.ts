import { describe, expect, it } from 'vitest';
import {
  planPatchSchema,
  planSchema,
} from '@/modules/plans/domain/plan-validators';

const validCorporateInput = {
  plan_id: 'premium',
  plan_year: 2026,
  plan_name: { en: 'Premium Corporate' },
  description: { en: 'Test description' },
  sort_order: 10,
  plan_category: 'corporate' as const,
  member_type_scope: 'company' as const,
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: 10_000_000_000,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: {
    eblast_per_year: 6,
    website_page_type: 'member_news_update' as const,
    homepage_logo_category: 'premium' as const,
    directory_listing_size: 'full_page' as const,
    event_discount_scope: 'all_employees' as const,
    events_cobranded_access: true,
    cultural_tickets_per_year: 2,
    m2m_benefits_access: true,
    business_referrals: true,
    tailor_made_services: true,
    partnership: null,
  },
};

const validPartnershipInput = {
  ...validCorporateInput,
  plan_id: 'diamond',
  plan_name: { en: 'Diamond Partnership' },
  plan_category: 'partnership' as const,
  includes_corporate_plan_id: 'premium',
  annual_fee_minor_units: 20_000_000,
  benefit_matrix: {
    ...validCorporateInput.benefit_matrix,
    partnership: {
      event_tickets_included: 6,
      booth_included: true,
      rollup_logo_at_events: true,
      logo_on_merch: true,
      video_duration_minutes: 1.5 as const,
      video_frequency_scope: 'all_events' as const,
      website_logo_months: 12,
      banner_per_year: 20,
      newsletter_promotion: true,
      enewsletter_logo: true,
      directory_ad_position: 'pages_1_and_2' as const,
    },
  },
};

describe('planSchema', () => {
  it('accepts a valid corporate plan', () => {
    expect(planSchema.safeParse(validCorporateInput).success).toBe(true);
  });

  it('accepts a valid partnership plan', () => {
    expect(planSchema.safeParse(validPartnershipInput).success).toBe(true);
  });

  it('rejects partnership without includes_corporate_plan_id', () => {
    const result = planSchema.safeParse({
      ...validPartnershipInput,
      includes_corporate_plan_id: null,
    });
    expect(result.success).toBe(false);
  });

  it('rejects partnership without benefit_matrix.partnership', () => {
    const result = planSchema.safeParse({
      ...validPartnershipInput,
      benefit_matrix: { ...validPartnershipInput.benefit_matrix, partnership: null },
    });
    expect(result.success).toBe(false);
  });

  it('rejects corporate with includes_corporate_plan_id set', () => {
    const result = planSchema.safeParse({
      ...validCorporateInput,
      includes_corporate_plan_id: 'premium',
    });
    expect(result.success).toBe(false);
  });

  it('rejects corporate with partnership benefits', () => {
    const result = planSchema.safeParse({
      ...validCorporateInput,
      benefit_matrix: {
        ...validCorporateInput.benefit_matrix,
        partnership: validPartnershipInput.benefit_matrix.partnership,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects min_turnover >= max_turnover', () => {
    const result = planSchema.safeParse({
      ...validCorporateInput,
      min_turnover_minor_units: 5_000_000_000,
      max_turnover_minor_units: 5_000_000_000,
    });
    expect(result.success).toBe(false);
  });

  it('accepts min_turnover < max_turnover', () => {
    expect(
      planSchema.safeParse({
        ...validCorporateInput,
        min_turnover_minor_units: 5_000_000_000,
        max_turnover_minor_units: 10_000_000_000,
      }).success,
    ).toBe(true);
  });

  it('rejects negative annual_fee', () => {
    expect(
      planSchema.safeParse({
        ...validCorporateInput,
        annual_fee_minor_units: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects float annual_fee', () => {
    expect(
      planSchema.safeParse({
        ...validCorporateInput,
        annual_fee_minor_units: 100.5,
      }).success,
    ).toBe(false);
  });

  it('rejects empty plan_name.en', () => {
    expect(
      planSchema.safeParse({
        ...validCorporateInput,
        plan_name: { en: '' },
      }).success,
    ).toBe(false);
  });

  it('rejects plan_id with spaces', () => {
    expect(
      planSchema.safeParse({
        ...validCorporateInput,
        plan_id: 'start up',
      }).success,
    ).toBe(false);
  });

  it('rejects plan_year outside 2000..2100', () => {
    expect(
      planSchema.safeParse({ ...validCorporateInput, plan_year: 1999 }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({ ...validCorporateInput, plan_year: 2101 }).success,
    ).toBe(false);
  });
});

describe('planPatchSchema', () => {
  it('accepts an empty patch', () => {
    expect(planPatchSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single-field patch', () => {
    expect(
      planPatchSchema.safeParse({ plan_name: { en: 'Premium' } }).success,
    ).toBe(true);
  });

  it('rejects negative annual_fee on patch', () => {
    expect(
      planPatchSchema.safeParse({ annual_fee_minor_units: -1 }).success,
    ).toBe(false);
  });

  it('rejects min_turnover >= max_turnover in patch', () => {
    expect(
      planPatchSchema.safeParse({
        min_turnover_minor_units: 100,
        max_turnover_minor_units: 100,
      }).success,
    ).toBe(false);
  });

  it('rejects partnership category patch without includes_corporate_plan_id', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'partnership',
        includes_corporate_plan_id: null,
      }).success,
    ).toBe(false);
  });

  it('accepts partnership patch with includes_corporate_plan_id present', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'partnership',
        includes_corporate_plan_id: 'premium',
      }).success,
    ).toBe(true);
  });

  it('rejects corporate patch with includes_corporate_plan_id set', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'corporate',
        includes_corporate_plan_id: 'premium',
      }).success,
    ).toBe(false);
  });

  it('accepts corporate patch with includes_corporate_plan_id undefined', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'corporate',
      }).success,
    ).toBe(true);
  });

  it('rejects partnership patch with null benefit_matrix.partnership', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'partnership',
        includes_corporate_plan_id: 'premium',
        benefit_matrix: {
          ...validCorporateInput.benefit_matrix,
          partnership: null,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects corporate patch with non-null benefit_matrix.partnership', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'corporate',
        benefit_matrix: {
          ...validCorporateInput.benefit_matrix,
          partnership: validPartnershipInput.benefit_matrix.partnership,
        },
      }).success,
    ).toBe(false);
  });

  it('accepts partnership patch when benefit_matrix is omitted', () => {
    expect(
      planPatchSchema.safeParse({
        plan_category: 'partnership',
        includes_corporate_plan_id: 'premium',
      }).success,
    ).toBe(true);
  });
});
