// Shared Plan fixture for the /admin/plans page tests.
import type { Plan } from '@/modules/plans';

const PARTNERSHIP = {
  event_tickets_included: 4,
  booth_included: true,
  rollup_logo_at_events: true,
  logo_on_merch: false,
  video_duration_minutes: 1.5,
  video_frequency_scope: 'three_selected_events',
  website_logo_months: 12,
  banner_per_year: 2,
  newsletter_promotion: true,
  enewsletter_logo: false,
  directory_ad_position: 'first_pages',
} as const;

export function makePlan(overrides: Partial<Record<keyof Plan, unknown>> = {}): Plan {
  const category = (overrides.plan_category as Plan['plan_category'] | undefined) ?? 'corporate';
  return {
    tenant_id: 'swecham',
    plan_id: 'diamond',
    plan_year: 2026,
    plan_name: { en: 'Diamond' },
    description: { en: 'Top corporate tier' },
    sort_order: 10,
    plan_category: category,
    member_type_scope: 'company',
    annual_fee_minor_units: 3_600_000,
    includes_corporate_plan_id: category === 'partnership' ? 'diamond' : null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: {
      eblast_per_year: 4,
      website_page_type: 'member_news_update',
      homepage_logo_category: 'premium',
      directory_listing_size: 'full_page',
      event_discount_scope: 'all_employees',
      events_cobranded_access: true,
      cultural_tickets_per_year: 2,
      m2m_benefits_access: true,
      business_referrals: false,
      tailor_made_services: true,
      partnership: category === 'partnership' ? PARTNERSHIP : null,
    },
    is_active: true,
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    created_by: '00000000-0000-0000-0000-000000000001',
    updated_by: '00000000-0000-0000-0000-000000000001',
    ...overrides,
  } as unknown as Plan;
}
