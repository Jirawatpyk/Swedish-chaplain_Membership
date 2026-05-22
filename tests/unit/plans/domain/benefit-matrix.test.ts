import { describe, expect, it } from 'vitest';
import {
  benefitMatrixSchema,
  partnershipBenefitsSchema,
} from '@/modules/plans/domain/plan-validators';
import {
  asBenefitMatrix,
  InvalidBenefitMatrixError,
  type BenefitMatrix,
  type CorporateBenefitMatrix,
  type PartnershipBenefitMatrix,
} from '@/modules/plans/domain/benefit-matrix';

describe('BenefitMatrix validation (via zod schemas)', () => {
  const baseCorporate = {
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
  };

  const validPartnership = {
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
  };

  it('accepts a valid corporate benefit matrix (partnership null)', () => {
    const result = benefitMatrixSchema.safeParse(baseCorporate);
    expect(result.success).toBe(true);
  });

  it('accepts a valid partnership benefit matrix', () => {
    const result = benefitMatrixSchema.safeParse({
      ...baseCorporate,
      partnership: validPartnership,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown website_page_type enum value', () => {
    const result = benefitMatrixSchema.safeParse({
      ...baseCorporate,
      website_page_type: 'invalid_page',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown homepage_logo_category enum value', () => {
    const result = benefitMatrixSchema.safeParse({
      ...baseCorporate,
      homepage_logo_category: 'GIGANTIC',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative eblast_per_year', () => {
    const result = benefitMatrixSchema.safeParse({
      ...baseCorporate,
      eblast_per_year: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects partnership with out-of-range video_duration_minutes', () => {
    const result = partnershipBenefitsSchema.safeParse({
      ...validPartnership,
      video_duration_minutes: 2.0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects partnership with unknown directory_ad_position', () => {
    const result = partnershipBenefitsSchema.safeParse({
      ...validPartnership,
      directory_ad_position: 'back_page',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-ship R6 Batch 2a (D5) — `asBenefitMatrix` smart constructor
// ---------------------------------------------------------------------------
//
// Validates the partnership↔corporate integrity invariant at the
// Domain boundary. Complements the zod schema (HTTP/API boundary)
// + DB CHECK constraint (persistence boundary). Same intent as
// `asLocaleText` smart constructor in Batch 1d — Domain code that
// bypasses zod (test fixtures, seed scripts, future use-cases) gets
// a single validating helper instead of duplicating the invariant
// check at each call site.
describe('asBenefitMatrix — Domain smart constructor', () => {
  const corporateBase: BenefitMatrix = {
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

  const partnershipBase: BenefitMatrix = {
    ...corporateBase,
    partnership: {
      event_tickets_included: 6,
      booth_included: true,
      rollup_logo_at_events: true,
      logo_on_merch: true,
      video_duration_minutes: 1.5,
      video_frequency_scope: 'all_events',
      website_logo_months: 12,
      banner_per_year: 20,
      newsletter_promotion: true,
      enewsletter_logo: true,
      directory_ad_position: 'pages_1_and_2',
    },
  };

  it('accepts a valid corporate matrix (partnership null) under planCategory=corporate', () => {
    const result = asBenefitMatrix(corporateBase, 'corporate');
    expect(result).toEqual(corporateBase);
    // Same reference — the constructor is identity on valid input
    expect(result).toBe(corporateBase);
  });

  it('accepts a valid partnership matrix (partnership non-null) under planCategory=partnership', () => {
    const result = asBenefitMatrix(partnershipBase, 'partnership');
    expect(result).toEqual(partnershipBase);
  });

  it('rejects corporate matrix with populated partnership block', () => {
    expect(() =>
      asBenefitMatrix(partnershipBase, 'corporate'),
    ).toThrowError(InvalidBenefitMatrixError);
    expect(() => asBenefitMatrix(partnershipBase, 'corporate')).toThrow(
      /corporate plan must have `partnership: null`/,
    );
  });

  it('rejects partnership matrix with null partnership block', () => {
    expect(() =>
      asBenefitMatrix(corporateBase, 'partnership'),
    ).toThrowError(InvalidBenefitMatrixError);
    expect(() => asBenefitMatrix(corporateBase, 'partnership')).toThrow(
      /partnership plan must have a non-null `partnership` block/,
    );
  });

  it('InvalidBenefitMatrixError name + extends Error', () => {
    try {
      asBenefitMatrix(partnershipBase, 'corporate');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidBenefitMatrixError);
      expect(e).toBeInstanceOf(Error);
      expect((e as InvalidBenefitMatrixError).name).toBe(
        'InvalidBenefitMatrixError',
      );
    }
  });

  it('does not mutate input', () => {
    const input: BenefitMatrix = { ...corporateBase };
    const snapshot = JSON.stringify(input);
    asBenefitMatrix(input, 'corporate');
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('preserves all field values verbatim', () => {
    const result = asBenefitMatrix(partnershipBase, 'partnership');
    expect(result.eblast_per_year).toBe(partnershipBase.eblast_per_year);
    expect(result.website_page_type).toBe(partnershipBase.website_page_type);
    expect(result.partnership).toBe(partnershipBase.partnership);
    expect(result.partnership?.event_tickets_included).toBe(6);
    expect(result.partnership?.directory_ad_position).toBe('pages_1_and_2');
  });

  it('BenefitMatrix is structural — object literal assignable without smart constructor (soft pattern)', () => {
    // Compile-time check: BenefitMatrix is a structural type, so an
    // object literal can be assigned without `asBenefitMatrix(...)`.
    // If a future round flips BenefitMatrix to a branded
    // intersection, this test would fail and signal the need for
    // explicit `asBenefitMatrix(...)` at all call sites that build
    // literals.
    const lit: BenefitMatrix = corporateBase;
    const matrix: BenefitMatrix = lit;
    expect(matrix).toEqual(corporateBase);
  });
});

// ---------------------------------------------------------------------------
// R3 Batch 4f (R3-S7) — BenefitMatrix discriminated union over `partnership`
// ---------------------------------------------------------------------------
//
// The smart constructor now narrows the return type via overloads:
//   - `asBenefitMatrix(m, 'corporate')`    → `CorporateBenefitMatrix`
//   - `asBenefitMatrix(m, 'partnership')`  → `PartnershipBenefitMatrix`
//
// Consumers that previously needed `if (matrix.partnership !== null)`
// guards on a flat type now get the variant directly. The runtime
// invariant remains identical — the discriminant is a type-system
// upgrade, not a behaviour change.
describe('BenefitMatrix discriminated union (R3-S7)', () => {
  const corporateBase = {
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
  };
  const partnershipSub: PartnershipBenefitMatrix['partnership'] = {
    event_tickets_included: 4,
    booth_included: false,
    rollup_logo_at_events: true,
    logo_on_merch: false,
    video_duration_minutes: 1.5,
    video_frequency_scope: 'three_selected_events',
    website_logo_months: 6,
    banner_per_year: 15,
    newsletter_promotion: false,
    enewsletter_logo: true,
    directory_ad_position: 'first_pages',
  };

  it('asBenefitMatrix(_, "corporate") returns CorporateBenefitMatrix with partnership: null at type level', () => {
    const result: CorporateBenefitMatrix = asBenefitMatrix(
      { ...corporateBase, partnership: null },
      'corporate',
    );
    // partnership is exactly `null` — assignable to `null` (not `null | PartnershipBenefits`)
    const partnershipField: null = result.partnership;
    expect(partnershipField).toBeNull();
  });

  it('asBenefitMatrix(_, "partnership") returns PartnershipBenefitMatrix with non-null partnership at type level', () => {
    const result: PartnershipBenefitMatrix = asBenefitMatrix(
      { ...corporateBase, partnership: partnershipSub },
      'partnership',
    );
    // partnership is `PartnershipBenefits` — direct access without `?.`
    // is required by the compiler (the optional-chain `?.` below would
    // be flagged "unnecessary" if anyone reverts the discriminant).
    expect(result.partnership.event_tickets_included).toBe(4);
    expect(result.partnership.video_duration_minutes).toBe(1.5);
  });

  it('narrowing via `if (matrix.partnership !== null)` reaches PartnershipBenefitMatrix at type level', () => {
    const matrix: BenefitMatrix = asBenefitMatrix(
      { ...corporateBase, partnership: partnershipSub },
      'partnership',
    );
    if (matrix.partnership !== null) {
      // After this guard, TS narrows `matrix` to `PartnershipBenefitMatrix`
      // and `matrix.partnership` to `PartnershipBenefits` (non-null).
      const partnership: PartnershipBenefitMatrix['partnership'] =
        matrix.partnership;
      expect(partnership.video_frequency_scope).toBe('three_selected_events');
    } else {
      throw new Error('unreachable — fixture sets partnership non-null');
    }
  });

  it('CorporateBenefitMatrix structurally assignable to BenefitMatrix (union member)', () => {
    const corp: CorporateBenefitMatrix = {
      ...corporateBase,
      partnership: null,
    };
    const matrix: BenefitMatrix = corp;
    expect(matrix.partnership).toBeNull();
  });

  it('PartnershipBenefitMatrix structurally assignable to BenefitMatrix (union member)', () => {
    const partner: PartnershipBenefitMatrix = {
      ...corporateBase,
      partnership: partnershipSub,
    };
    const matrix: BenefitMatrix = partner;
    expect(matrix.partnership).not.toBeNull();
  });
});
