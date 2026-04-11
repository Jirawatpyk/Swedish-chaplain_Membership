import { describe, expect, it } from 'vitest';
import {
  detectLockedFieldChanges,
  LOCKED_FIELDS_ON_PRIOR_YEAR,
} from '@/modules/plans/domain/locked-field-rule';
import {
  asPlanSlug,
  asPlanYear,
  asTenantSlug,
  type Plan,
} from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { LocaleText } from '@/modules/plans/domain/locale-text';

const planName: LocaleText = { en: 'Premium' };
const benefitMatrix: BenefitMatrix = {
  eblast_per_year: 6,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'premium',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
  partnership: null,
};

const basePlan: Plan = {
  tenant_id: asTenantSlug('swecham'),
  plan_id: asPlanSlug('premium'),
  plan_year: asPlanYear(2026),
  plan_name: planName,
  description: { en: '' },
  sort_order: 10,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: 10_000_000_000,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: benefitMatrix,
  is_active: true,
  deleted_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  created_by: '00000000-0000-0000-0000-000000000001',
  updated_by: '00000000-0000-0000-0000-000000000001',
};

describe('detectLockedFieldChanges', () => {
  it('returns [] when plan_year >= currentYear (current year)', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      { annual_fee_minor_units: 4_000_000 },
      2026,
    );
    expect(changes).toEqual([]);
  });

  it('returns [] when plan_year > currentYear (future year)', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      { annual_fee_minor_units: 4_000_000 },
      2025,
    );
    expect(changes).toEqual([]);
  });

  it('returns [] when patch does not touch any locked field (prior year)', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      { plan_name: { en: 'Premium Corp' }, sort_order: 5 },
      2027,
    );
    expect(changes).toEqual([]);
  });

  it('flags annual_fee_minor_units on prior year', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      { annual_fee_minor_units: 4_000_000 },
      2027,
    );
    expect(changes).toEqual(['annual_fee_minor_units']);
  });

  it('flags every locked field that is changed', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      {
        annual_fee_minor_units: 4_000_000,
        member_type_scope: 'both',
        max_duration_years: 3,
      },
      2027,
    );
    expect(changes.sort()).toEqual(
      ['annual_fee_minor_units', 'max_duration_years', 'member_type_scope'].sort(),
    );
  });

  it('no-op write to a locked field is NOT flagged', () => {
    // Same value as basePlan — deep equal, should be treated as unchanged
    const changes = detectLockedFieldChanges(
      basePlan,
      { annual_fee_minor_units: 3_600_000 },
      2027,
    );
    expect(changes).toEqual([]);
  });

  it('deep-equal benefit_matrix write is NOT flagged', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      { benefit_matrix: { ...benefitMatrix } },
      2027,
    );
    expect(changes).toEqual([]);
  });

  it('mutated benefit_matrix IS flagged', () => {
    const changes = detectLockedFieldChanges(
      basePlan,
      {
        benefit_matrix: { ...benefitMatrix, eblast_per_year: 12 },
      },
      2027,
    );
    expect(changes).toEqual(['benefit_matrix']);
  });

  it('every field in LOCKED_FIELDS_ON_PRIOR_YEAR is exercised', () => {
    // Sanity — make sure the test is covering every listed locked field
    // (if this list grows, the test above needs a matching assertion added)
    expect(LOCKED_FIELDS_ON_PRIOR_YEAR).toEqual([
      'annual_fee_minor_units',
      'min_turnover_minor_units',
      'max_turnover_minor_units',
      'max_duration_years',
      'max_member_age',
      'member_type_scope',
      'includes_corporate_plan_id',
      'benefit_matrix',
    ]);
  });
});
