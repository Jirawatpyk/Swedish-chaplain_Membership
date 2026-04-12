/**
 * `BenefitMatrix` — typed benefit structure mirroring
 * `docs/membership-benefits-analysis.md` §2 + §3 and the PDF 2026
 * package. Used by both Corporate (6 tiers) and Partnership (3 tiers)
 * plans.
 *
 * Design:
 *   - Flat, typed record — IDE autocomplete + exhaustive enum checks
 *   - Partnership-only fields live under `partnership: null | { ... }`
 *     discriminated off `plan_category` (validator enforces non-null
 *     for partnership plans, null for corporate plans — data-model.md § 2.2)
 *   - Enum fields use nullable string unions so the Drizzle JSONB write
 *     round-trips through Postgres without extra serialisation
 *   - `video_duration_minutes` is a narrow `1.0 | 1.5` union (the only
 *     two observed values in the PDF)
 *
 * Pure TypeScript — no framework imports.
 */

// --- Shared enums (also persisted as Postgres pgEnums) ------------------------

export type WebsitePageType =
  | 'member_news_update'
  | 'smes_spotlight'
  | 'student_intern_cv';

export type HomepageLogoCategory = 'premium' | 'large' | 'regular' | 'start_up';

export type DirectoryListingSize = 'full_page' | 'half_page' | 'eighth_page';

export type EventDiscountScope =
  | 'all_employees'
  | 'one_ticket_per_event'
  | 'none';

export type VideoFrequencyScope = 'all_events' | 'three_selected_events';

export type DirectoryAdPosition =
  | 'pages_1_and_2'
  | 'first_pages'
  | 'first_10_pages';

// --- Partnership-only sub-block -----------------------------------------------

export type PartnershipBenefits = {
  readonly event_tickets_included: number; // 6 / 4 / 2
  readonly booth_included: boolean;
  readonly rollup_logo_at_events: boolean;
  readonly logo_on_merch: boolean;
  readonly video_duration_minutes: 1.0 | 1.5;
  readonly video_frequency_scope: VideoFrequencyScope;
  readonly website_logo_months: number; // 12 / 6 / 3
  readonly banner_per_year: number; // 20 / 15 / 10
  readonly newsletter_promotion: boolean;
  readonly enewsletter_logo: boolean;
  readonly directory_ad_position: DirectoryAdPosition;
};

// --- Full benefit matrix ------------------------------------------------------

export type BenefitMatrix = {
  // Brand Visibility (both categories)
  readonly eblast_per_year: number;
  readonly website_page_type: WebsitePageType | null;
  readonly homepage_logo_category: HomepageLogoCategory | null;
  readonly directory_listing_size: DirectoryListingSize | null;

  // Events (base — both categories)
  readonly event_discount_scope: EventDiscountScope;
  readonly events_cobranded_access: boolean;
  readonly cultural_tickets_per_year: number;

  // Additional corporate benefits
  readonly m2m_benefits_access: boolean;
  readonly business_referrals: boolean;
  readonly tailor_made_services: boolean;

  // Partnership-only — null for corporate plans
  readonly partnership: PartnershipBenefits | null;
};
