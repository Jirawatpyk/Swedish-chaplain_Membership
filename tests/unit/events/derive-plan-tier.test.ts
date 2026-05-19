/**
 * Phase 6 staff-review-4 Round 7 TEST-FR-02 closure — direct unit
 * coverage for `derivePlanTier` (the source-of-truth classifier for
 * the PERF-05 OTel `plan_tier` label).
 *
 * Why this test exists separately:
 *   - The classifier is the ONLY layer that maps `plan_id` slug →
 *     OTel counter label. A regression (e.g., regex narrowed back to
 *     `^[a-z]+`, or an allowlist entry typo) silently degrades the
 *     entire SweCham per-tier observability dashboard to
 *     `plan_tier='unknown'`.
 *   - Integration tests in `quota-accounting.test.ts` only assert
 *     payload.fiscalYear, never payload.planTier — they would not
 *     catch a classifier regression.
 *   - Round 7 CODE-FR-01 closure shipped this classifier with the
 *     CORRECTED canonical SweCham 2026 plan slugs (per
 *     `docs/membership-benefits-analysis.md:157`); the Round 6 wave
 *     accidentally shipped a fictional allowlist with `small` +
 *     `standard` (never existed on SweCham) and omitted 4 of 6
 *     corporate tiers.
 */
import { describe, expect, it } from 'vitest';
import {
  derivePlanTier,
  KNOWN_PLAN_TIERS,
} from '@/modules/events/infrastructure/drizzle-quota-accounting-adapter';

describe('derivePlanTier — R7 TEST-FR-02 + CODE-FR-01 closure', () => {
  describe('accepts canonical SweCham 2026 corporate tier slugs (6)', () => {
    it.each([
      ['premium', 'premium'],
      ['large', 'large'],
      ['regular', 'regular'],
      ['start-up', 'start-up'],
      ['individual', 'individual'],
      ['thai-alumni', 'thai-alumni'],
    ])('classifies %s → %s', (input, expected) => {
      expect(derivePlanTier(input)).toBe(expected);
    });
  });

  describe('accepts canonical SweCham 2026 partnership tier slugs (3)', () => {
    it.each([
      ['diamond', 'diamond'],
      ['platinum', 'platinum'],
      ['gold', 'gold'],
    ])('classifies %s → %s', (input, expected) => {
      expect(derivePlanTier(input)).toBe(expected);
    });
  });

  describe('strips trailing year suffix (-YYYY) before lookup', () => {
    it.each([
      ['diamond-2026', 'diamond'],
      ['premium-2026', 'premium'],
      ['start-up-2026', 'start-up'], // hyphenated slug preserved
      ['thai-alumni-2027', 'thai-alumni'], // hyphenated slug preserved
      ['gold-2030', 'gold'],
    ])('strips year from %s → %s', (input, expected) => {
      expect(derivePlanTier(input)).toBe(expected);
    });
  });

  describe('lowercases input before matching', () => {
    it('accepts mixed-case `Diamond`', () => {
      expect(derivePlanTier('Diamond')).toBe('diamond');
    });
    it('accepts mixed-case `Start-Up-2026`', () => {
      expect(derivePlanTier('Start-Up-2026')).toBe('start-up');
    });
    it('accepts uppercase `THAI-ALUMNI`', () => {
      expect(derivePlanTier('THAI-ALUMNI')).toBe('thai-alumni');
    });
  });

  describe('returns null for unknown / malformed slugs (label degrades to "unknown")', () => {
    it('returns null for empty string', () => {
      expect(derivePlanTier('')).toBeNull();
    });
    it('returns null for unknown tier `enterprise`', () => {
      expect(derivePlanTier('enterprise')).toBeNull();
    });
    it('returns null for unknown tier with year suffix `titanium-2026`', () => {
      expect(derivePlanTier('titanium-2026')).toBeNull();
    });
    it('returns null for `small` (R6 fictional tier — was wrongly in old allowlist)', () => {
      expect(derivePlanTier('small')).toBeNull();
    });
    it('returns null for `standard` (R6 fictional tier — was wrongly in old allowlist)', () => {
      expect(derivePlanTier('standard')).toBeNull();
    });
    it('returns null for numeric-only `2026`', () => {
      expect(derivePlanTier('2026')).toBeNull();
    });
    it('returns null for symbol-prefixed `_diamond`', () => {
      // Underscore prefix would not match a year-suffix strip and is
      // not in the allowlist.
      expect(derivePlanTier('_diamond')).toBeNull();
    });
  });

  describe('KNOWN_PLAN_TIERS constant invariants (drift guard)', () => {
    it('exports exactly 9 canonical tier slugs (6 corporate + 3 partnership)', () => {
      expect(KNOWN_PLAN_TIERS.length).toBe(9);
    });

    it('contains all 6 SweCham 2026 corporate tiers', () => {
      const corporate = ['premium', 'large', 'regular', 'start-up', 'individual', 'thai-alumni'];
      for (const t of corporate) {
        expect((KNOWN_PLAN_TIERS as readonly string[]).includes(t)).toBe(true);
      }
    });

    it('contains all 3 SweCham 2026 partnership tiers', () => {
      const partnership = ['diamond', 'platinum', 'gold'];
      for (const t of partnership) {
        expect((KNOWN_PLAN_TIERS as readonly string[]).includes(t)).toBe(true);
      }
    });

    it('does NOT contain the R6 fictional `small` tier', () => {
      expect((KNOWN_PLAN_TIERS as readonly string[]).includes('small')).toBe(false);
    });

    it('does NOT contain the R6 fictional `standard` tier', () => {
      expect((KNOWN_PLAN_TIERS as readonly string[]).includes('standard')).toBe(false);
    });
  });
});
