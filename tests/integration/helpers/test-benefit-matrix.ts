/**
 * Wave J12 S6 — shared default `BenefitMatrix` fixture for F8 integration
 * tests.
 *
 * Replaces the verbatim 12-field `TEST_BENEFIT_MATRIX` const that appeared
 * in 13 F8 integration files. The shape never varies between callers —
 * tests just need a valid matrix to populate the `membership_plans` row
 * the F8 cycle/member fixtures point at.
 *
 * If a test ever needs a different tier (e.g. partnership vs regular),
 * spread + override:
 *   const partnershipMatrix = { ...DEFAULT_TEST_BENEFIT_MATRIX, partnership: 'gold' };
 */
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

export const DEFAULT_TEST_BENEFIT_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};
