/**
 * T095 — Integration: create-plan validation (US2).
 *
 * Exhaustive zod-schema coverage via the real `planSchema` from
 * `@/modules/plans/domain/plan-validators`. Does not hit the DB;
 * complements the contract test by asserting that every documented
 * validation rule fires (or does not fire) as expected.
 *
 * Rules exercised:
 *   - plan_id regex (lower-case alphanum + hyphen, 1..63)
 *   - plan_year range [2000, 2100]
 *   - plan_name.en required + min length
 *   - money minor_units non-negative integer
 *   - corporate integrity: includes_corporate_plan_id must be null,
 *     benefit_matrix.partnership must be null
 *   - partnership integrity: includes_corporate_plan_id required,
 *     benefit_matrix.partnership must be populated
 *   - turnover ordering (min < max when both set)
 */
import { describe, expect, it } from 'vitest';
import { planSchema } from '@/modules/plans/domain/plan-validators';

const CORPORATE_BASE = {
  plan_id: 'premium',
  plan_year: 2026,
  plan_name: { en: 'Premium' },
  description: { en: 'Test description' },
  sort_order: 10,
  plan_category: 'corporate' as const,
  member_type_scope: 'company' as const,
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
    event_discount_scope: 'none' as const,
    events_cobranded_access: false,
    cultural_tickets_per_year: 0,
    m2m_benefits_access: false,
    business_referrals: false,
    tailor_made_services: false,
    partnership: null,
  },
};

const PARTNERSHIP_BENEFITS = {
  event_tickets_included: 10,
  booth_included: true,
  rollup_logo_at_events: true,
  logo_on_merch: false,
  video_duration_minutes: 1.5 as const,
  video_frequency_scope: 'all_events' as const,
  website_logo_months: 12,
  banner_per_year: 4,
  newsletter_promotion: true,
  enewsletter_logo: true,
  directory_ad_position: 'first_pages' as const,
};

describe('Integration: create-plan validation (T095)', () => {
  it('accepts a valid corporate plan', () => {
    const parsed = planSchema.safeParse(CORPORATE_BASE);
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid partnership plan with corporate bundle', () => {
    const input = {
      ...CORPORATE_BASE,
      plan_id: 'platinum',
      plan_category: 'partnership' as const,
      includes_corporate_plan_id: 'premium',
      benefit_matrix: {
        ...CORPORATE_BASE.benefit_matrix,
        partnership: PARTNERSHIP_BENEFITS,
      },
    };
    const parsed = planSchema.safeParse(input);
    expect(parsed.success).toBe(true);
  });

  it('rejects plan_id with uppercase letters', () => {
    const parsed = planSchema.safeParse({ ...CORPORATE_BASE, plan_id: 'Premium' });
    expect(parsed.success).toBe(false);
  });

  it('rejects plan_id longer than 63 chars', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      plan_id: 'a'.repeat(64),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects plan_year below 2000', () => {
    const parsed = planSchema.safeParse({ ...CORPORATE_BASE, plan_year: 1999 });
    expect(parsed.success).toBe(false);
  });

  it('rejects plan_year above 2100', () => {
    const parsed = planSchema.safeParse({ ...CORPORATE_BASE, plan_year: 2101 });
    expect(parsed.success).toBe(false);
  });

  it('rejects missing plan_name.en', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      plan_name: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty plan_name.en (whitespace)', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      plan_name: { en: '   ' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects negative annual_fee_minor_units', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      annual_fee_minor_units: -1,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-integer annual_fee_minor_units (0.5)', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      annual_fee_minor_units: 100.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects corporate plan with includes_corporate_plan_id set', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      includes_corporate_plan_id: 'another',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects corporate plan with benefit_matrix.partnership populated', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      benefit_matrix: {
        ...CORPORATE_BASE.benefit_matrix,
        partnership: PARTNERSHIP_BENEFITS,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects partnership plan missing includes_corporate_plan_id', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      plan_category: 'partnership' as const,
      includes_corporate_plan_id: null,
      benefit_matrix: {
        ...CORPORATE_BASE.benefit_matrix,
        partnership: PARTNERSHIP_BENEFITS,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects partnership plan with null benefit_matrix.partnership', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      plan_category: 'partnership' as const,
      includes_corporate_plan_id: 'premium',
      benefit_matrix: {
        ...CORPORATE_BASE.benefit_matrix,
        partnership: null,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects min_turnover >= max_turnover', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      min_turnover_minor_units: 10_000_000_00,
      max_turnover_minor_units: 10_000_000_00,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts min_turnover < max_turnover', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      min_turnover_minor_units: 5_000_000_00,
      max_turnover_minor_units: 10_000_000_00,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts large annual fee up to 10B minor units (F2 max)', () => {
    const parsed = planSchema.safeParse({
      ...CORPORATE_BASE,
      annual_fee_minor_units: 10_000_000_000,
    });
    expect(parsed.success).toBe(true);
  });
});
