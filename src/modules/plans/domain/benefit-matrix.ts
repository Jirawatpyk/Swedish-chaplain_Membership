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
  // Narrow union `1.0 | 1.5` enforced both at the zod write boundary
  // (`partnershipBenefitsSchema`) AND at hydration via
  // `asBenefitMatrix` (which now asserts the narrow values when
  // `planCategory === 'partnership'`).
  readonly video_duration_minutes: 1.0 | 1.5;
  readonly video_frequency_scope: VideoFrequencyScope;
  readonly website_logo_months: number; // 12 / 6 / 3
  readonly banner_per_year: number; // 20 / 15 / 10
  readonly newsletter_promotion: boolean;
  readonly enewsletter_logo: boolean;
  readonly directory_ad_position: DirectoryAdPosition;
};

// --- Full benefit matrix ------------------------------------------------------

/**
 * Base fields shared by every plan category. Discriminated subtypes
 * (`CorporateBenefitMatrix` / `PartnershipBenefitMatrix`) below add the
 * category-specific `partnership` shape.
 */
type BenefitMatrixBase = {
  // Brand Visibility (both categories)
  readonly eblast_per_year: number;
  readonly website_page_type: WebsitePageType | null;
  readonly homepage_logo_category: HomepageLogoCategory | null;
  readonly directory_listing_size: DirectoryListingSize | null;

  // Events (base — both categories)
  readonly event_discount_scope: EventDiscountScope;
  readonly events_cobranded_access: boolean;
  readonly cultural_tickets_per_year: number;

  // Additional corporate benefits (semantically partnership plans don't
  // expose M2M / referrals / tailor-made — schema/DB still stores
  // boolean, validator enforces shape per data-model.md § 2.2).
  readonly m2m_benefits_access: boolean;
  readonly business_referrals: boolean;
  readonly tailor_made_services: boolean;
};

/**
 * Compile-time discriminated union over the `partnership` field. The
 * partnership↔corporate invariant (`plan_category === 'partnership'`
 * ⇔ non-null `partnership`) is encoded in the TYPE (not just in the
 * smart constructor + data-model.md § 2.2 comments).
 *
 * Code consumers narrow via `if (matrix.partnership !== null)` to get
 * `PartnershipBenefitMatrix`; the structural-union surface remains
 * compatible with the existing reader call sites in
 * `src/components/plans/**` + `src/app/(staff)/admin/plans/**`.
 *
 * Scope note: `Plan.benefit_matrix` continues to be `BenefitMatrix`
 * (the union) rather than discriminating `Plan` itself. The discriminant
 * is reachable via the matrix's `partnership` field — narrowing once
 * via `matrix.partnership !== null` gives the consumer the variant
 * shape it needs.
 */
export type CorporateBenefitMatrix = BenefitMatrixBase & {
  readonly partnership: null;
};

export type PartnershipBenefitMatrix = BenefitMatrixBase & {
  readonly partnership: PartnershipBenefits;
};

export type BenefitMatrix = CorporateBenefitMatrix | PartnershipBenefitMatrix;

export class InvalidBenefitMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBenefitMatrixError';
  }
}

/**
 * Loose input shape — accepts the structural type before the
 * discriminated union narrows. Mirrors `MutableScheduledPlanChange`:
 * the smart constructor takes this looser shape, runtime-validates,
 * and returns the discriminated variant.
 */
type BenefitMatrixInput = BenefitMatrixBase & {
  readonly partnership: PartnershipBenefits | null;
};

/**
 * Smart constructor enforcing the partnership↔corporate integrity
 * invariant at the Domain boundary (zod `benefitMatrixSchema` covers
 * the HTTP edge; this catches non-zod construction paths like seed
 * scripts, test fixtures, and `plan-repo.ts:rowToPlan` hydration).
 *
 * - `planCategory === 'corporate'` → `partnership` MUST be null
 * - `planCategory === 'partnership'` → `partnership` MUST be non-null
 *
 * Overloads narrow the return type to the discriminated variant
 * matching the caller's `planCategory`. A code site that calls
 * `asBenefitMatrix(m, 'partnership')` gets `PartnershipBenefitMatrix`
 * (with non-null `partnership` field at the type level) — no need for
 * `if (matrix.partnership !== null)` guards downstream.
 *
 * @throws InvalidBenefitMatrixError on mismatch
 */
export function asBenefitMatrix(
  input: BenefitMatrixInput,
  planCategory: 'corporate',
): CorporateBenefitMatrix;
export function asBenefitMatrix(
  input: BenefitMatrixInput,
  planCategory: 'partnership',
): PartnershipBenefitMatrix;
export function asBenefitMatrix(
  input: BenefitMatrixInput,
  planCategory: 'corporate' | 'partnership',
): BenefitMatrix;
export function asBenefitMatrix(
  input: BenefitMatrixInput,
  planCategory: 'corporate' | 'partnership',
): BenefitMatrix {
  if (planCategory === 'corporate' && input.partnership !== null) {
    throw new InvalidBenefitMatrixError(
      'asBenefitMatrix: corporate plan must have `partnership: null`',
    );
  }
  if (planCategory === 'partnership' && input.partnership === null) {
    throw new InvalidBenefitMatrixError(
      'asBenefitMatrix: partnership plan must have a non-null `partnership` block',
    );
  }
  // Runtime-assert the narrow union when planCategory='partnership'.
  // Zod enforces this at write boundary; DB JSONB return is `number`
  // which the structural type widens. A migration-introduced typo
  // (e.g., 1.25) would otherwise slip through hydration; the smart
  // constructor catches it.
  if (planCategory === 'partnership' && input.partnership !== null) {
    const v = input.partnership.video_duration_minutes;
    if (v !== 1.0 && v !== 1.5) {
      throw new InvalidBenefitMatrixError(
        `asBenefitMatrix: partnership.video_duration_minutes must be 1.0 or 1.5, got ${v}`,
      );
    }
  }
  // The runtime checks above narrow `input` to the matching variant.
  // The discriminated-union type system can't statically track that
  // narrowing across two distinct `if` branches, so cast to the union.
  return input as BenefitMatrix;
}
