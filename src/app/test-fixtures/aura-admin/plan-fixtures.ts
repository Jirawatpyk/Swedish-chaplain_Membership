/**
 * 122 US6 (T609) — sample plans for the preview's plans views, as the
 * `Admin-plans*` boards draw them: SweCham's nine 2026 plans, Premium
 * Corporate for the detail and edit pages.
 */
import { asBenefitMatrix, type Plan, type PlanListItem, type PlanSchemaInput } from '@/modules/plans';

export const PLAN_ID = 'premium-corporate';
export const PLAN_YEAR = 2026;

const THB = 100;

// [plan_id, name, category, fee in baht, member type, active]
const ROWS = [
  ['diamond-partnership', 'Diamond Partnership', 'partnership', 200_000, 'company', true],
  ['platinum-partnership', 'Platinum Partnership', 'partnership', 150_000, 'company', true],
  ['gold-partnership', 'Gold Partnership', 'partnership', 100_000, 'company', true],
  [PLAN_ID, 'Premium Corporate', 'corporate', 36_000, 'company', true],
  ['large-corporate', 'Large Corporate', 'corporate', 26_000, 'company', true],
  ['regular-corporate', 'Regular Corporate', 'corporate', 16_000, 'company', true],
  ['start-up', 'Start-up', 'corporate', 10_000, 'company', true],
  ['individual', 'Individual', 'corporate', 6_000, 'individual', true],
  ['thai-alumni-student', 'Thai Alumni/Student', 'corporate', 1_000, 'individual', false],
] as const;

export const PLAN_ROWS: PlanListItem[] = ROWS.map(([planId, name, category, fee, scope, active], i) => ({
  plan_id: planId,
  plan_year: PLAN_YEAR,
  plan_name: { en: name },
  description: { en: name },
  plan_category: category,
  member_type_scope: scope,
  annual_fee_minor_units: fee * THB,
  vat_rate: 0.07,
  total_with_vat_minor_units: Math.round(fee * THB * 1.07),
  includes_corporate_plan_id: null,
  is_active: active,
  deleted_at: null,
  created_at: '2025-12-01T03:00:00.000Z',
  updated_at: '2025-12-01T03:00:00.000Z',
  sort_order: (i + 1) * 10,
  missing_translations: [],
}));

export const CLONE_SOURCE_PLANS = PLAN_ROWS.map((p) => ({
  plan_id: p.plan_id,
  plan_name: p.plan_name,
  annual_fee_minor_units: p.annual_fee_minor_units,
  is_active: p.is_active,
}));

const PREMIUM_MATRIX = asBenefitMatrix(
  {
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
  },
  'corporate',
);

/** Premium Corporate as the edit form takes it; `year` 2025 for the locked board. */
export function premiumPlanInput(year: number): PlanSchemaInput {
  return {
    plan_id: PLAN_ID,
    plan_year: year,
    plan_name: { en: 'Premium Corporate', th: 'พรีเมียม คอร์ปอเรท' },
    description: {
      en: 'For companies with an annual turnover above 100 million THB.',
      th: 'สำหรับบริษัทที่มีรายได้ต่อปีมากกว่า 100 ล้านบาท',
    },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 36_000 * THB,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: 100_000_000 * THB,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: PREMIUM_MATRIX,
  };
}

/** Premium Corporate as the detail page reads it. */
export const PREMIUM_PLAN = {
  ...premiumPlanInput(PLAN_YEAR),
  plan_name: { en: 'Premium Corporate', th: 'พรีเมียม คอร์ปอเรท', sv: 'Premium Företag' },
  description: { en: 'For companies with an annual turnover above 100 million THB.' },
  tenant_id: 'swecham',
  is_active: true,
  deleted_at: null,
  created_at: new Date('2025-12-01T03:00:00Z'),
  updated_at: new Date('2025-12-01T03:00:00Z'),
  created_by: '00000000-0000-4000-8000-000000000001',
  updated_by: '00000000-0000-4000-8000-000000000001',
} as unknown as Plan;
