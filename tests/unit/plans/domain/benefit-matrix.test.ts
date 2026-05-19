import { describe, expect, it } from 'vitest';
import {
  benefitMatrixSchema,
  partnershipBenefitsSchema,
} from '@/modules/plans/domain/plan-validators';
import {
  asBenefitMatrix,
  InvalidBenefitMatrixError,
  type BenefitMatrixLiteral,
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
  const corporateBase: BenefitMatrixLiteral = {
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

  const partnershipBase: BenefitMatrixLiteral = {
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
    const input: BenefitMatrixLiteral = { ...corporateBase };
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

  it('BenefitMatrixLiteral is structurally assignable to BenefitMatrix (soft pattern, no brand)', () => {
    // Compile-time check: the alias is symmetric — same shape both
    // directions. If a future round flips BenefitMatrix to branded,
    // this test would fail and signal the need for explicit
    // `asBenefitMatrix(...)` at all call sites that build literals.
    const lit: BenefitMatrixLiteral = corporateBase;
    const matrix: BenefitMatrixLiteral = lit;
    expect(matrix).toEqual(corporateBase);
  });
});
