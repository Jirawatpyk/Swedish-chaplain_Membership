/**
 * F8 Phase 4 Wave I3 / T093-T098 spec — copy matrix completeness +
 * EN-fallback + interpolation.
 */
import { describe, expect, it } from 'vitest';
import {
  RENEWAL_COPY,
  RENEWAL_REMINDER_TIERS,
  TIER_LABELS,
  interpolateCopy,
  resolveCopy,
} from '@/modules/renewals/infrastructure/email/templates/copy';

// Schedule-policy email steps actually present in seed data
// (data-model.md § 2.4). Adapter must have an EN copy entry for each.
const REQUIRED_EN_KEYS: ReadonlyArray<string> = [
  'thai_alumni.t-30',
  'thai_alumni.t-14',
  'thai_alumni.t-3',
  'thai_alumni.t+7',
  'start_up.t-60',
  'start_up.t-30',
  'start_up.t-14',
  'start_up.t-7',
  'start_up.t+0',
  'start_up.t+7',
  'regular.t-60',
  'regular.t-30',
  'regular.t-14',
  'regular.t-7',
  'regular.t+0',
  'regular.t+7',
  'premium.t-90',
  'premium.t-60',
  'premium.t-30',
  'premium.t-14',
  'premium.t-7',
  'premium.t+0',
  'premium.t+14',
  'partnership.t-120',
  'partnership.t-90',
  'partnership.t-30',
  'partnership.t-14',
  'partnership.t+0',
  'partnership.t+30',
];

describe('renewal email copy matrix', () => {
  describe('completeness', () => {
    it('every schedule-policy email step has EN copy', () => {
      for (const key of REQUIRED_EN_KEYS) {
        expect(
          RENEWAL_COPY.en[key as keyof typeof RENEWAL_COPY.en],
          `EN copy missing for ${key}`,
        ).toBeDefined();
      }
    });

    it('every EN copy entry has subject + body + cta non-empty', () => {
      for (const [key, copy] of Object.entries(RENEWAL_COPY.en)) {
        expect(copy?.subject.length, `${key} subject empty`).toBeGreaterThan(0);
        expect(copy?.body.length, `${key} body empty`).toBeGreaterThan(0);
        expect(copy?.cta.length, `${key} cta empty`).toBeGreaterThan(0);
      }
    });

    it('J7b-H16: every schedule-policy email step has TH copy (no FR-013 fallback expected on production cron)', () => {
      for (const key of REQUIRED_EN_KEYS) {
        expect(
          RENEWAL_COPY.th[key as keyof typeof RENEWAL_COPY.th],
          `TH copy missing for ${key} — adding a new step without TH translation would silently fall back to EN for Thai-locale members. Add to copy.ts before merging.`,
        ).toBeDefined();
      }
    });

    it('J7b-H16: every schedule-policy email step has SV copy (no FR-013 fallback expected on production cron)', () => {
      for (const key of REQUIRED_EN_KEYS) {
        expect(
          RENEWAL_COPY.sv[key as keyof typeof RENEWAL_COPY.sv],
          `SV copy missing for ${key} — Swedish-locale members would silently get EN fallback. Add to copy.ts before merging.`,
        ).toBeDefined();
      }
    });

    it('J7b-H16: TH copy entries have non-empty subject/body/cta', () => {
      for (const [key, copy] of Object.entries(RENEWAL_COPY.th)) {
        expect(copy?.subject.length, `TH ${key} subject empty`).toBeGreaterThan(
          0,
        );
        expect(copy?.body.length, `TH ${key} body empty`).toBeGreaterThan(0);
        expect(copy?.cta.length, `TH ${key} cta empty`).toBeGreaterThan(0);
      }
    });

    it('J7b-H16: SV copy entries have non-empty subject/body/cta', () => {
      for (const [key, copy] of Object.entries(RENEWAL_COPY.sv)) {
        expect(copy?.subject.length, `SV ${key} subject empty`).toBeGreaterThan(
          0,
        );
        expect(copy?.body.length, `SV ${key} body empty`).toBeGreaterThan(0);
        expect(copy?.cta.length, `SV ${key} cta empty`).toBeGreaterThan(0);
      }
    });

    it('TIER_LABELS has entry for every tier in every locale', () => {
      for (const locale of ['en', 'th', 'sv'] as const) {
        for (const tier of RENEWAL_REMINDER_TIERS) {
          expect(
            TIER_LABELS[locale][tier],
            `${locale}.${tier} label missing`,
          ).toBeTruthy();
        }
      }
    });
  });

  describe('resolveCopy', () => {
    it('returns locale-specific copy when present', () => {
      const r = resolveCopy('thai_alumni', 't-30', 'th');
      expect(r.usedFallback).toBe(false);
      expect(r.copy.subject).toContain('สมาชิก');
    });

    it('falls back to EN when locale missing (FR-013)', () => {
      // J7b-H16: full TH/SV coverage now ships, so we can no longer
      // rely on a "perpetually missing" key for this test. Pin the
      // FR-013 fallback contract via a synthetic gap — temporarily
      // delete the TH entry, verify fallback, then restore. Other
      // tests are unaffected because the deletion is reverted in a
      // try/finally.
      const KEY = 'partnership.t-120' as const;
      const original = (RENEWAL_COPY.th as Record<string, unknown>)[KEY];
      delete (RENEWAL_COPY.th as Record<string, unknown>)[KEY];
      try {
        const r = resolveCopy('partnership', 't-120', 'th');
        expect(r.usedFallback).toBe(true);
        // Assert the fallback returned the EN copy (not the TH one).
        expect(r.copy.subject).toContain("let's plan ahead");
      } finally {
        if (original !== undefined) {
          (RENEWAL_COPY.th as Record<string, unknown>)[KEY] = original;
        }
      }
    });

    it('throws when EN itself is missing (catches schedule drift)', () => {
      expect(() =>
        // @ts-expect-error — intentionally invalid offset
        resolveCopy('regular', 't-999', 'en'),
      ).toThrow(/F8 reminder copy missing/);
    });

    it('does not fallback when locale is en explicitly', () => {
      const r = resolveCopy('regular', 't-30', 'en');
      expect(r.usedFallback).toBe(false);
    });
  });

  describe('interpolateCopy', () => {
    it('interpolates {firstName} + {companyName} + {tier} + {expiresAt} + {daysUntilExpiry}', () => {
      const result = interpolateCopy(
        'Hi {firstName}, {companyName} {tier} renews on {expiresAt} ({daysUntilExpiry} days)',
        {
          firstName: 'Anna',
          companyName: 'Acme Co',
          tier: 'Regular',
          expiresAt: '15 August 2026',
          daysUntilExpiry: 30,
        },
      );
      expect(result).toBe(
        'Hi Anna, Acme Co Regular renews on 15 August 2026 (30 days)',
      );
    });

    it('leaves unknown placeholders in place (visible breakage)', () => {
      const result = interpolateCopy('Hello {unknownVar}!', {
        firstName: 'Anna',
      });
      expect(result).toBe('Hello {unknownVar}!');
    });

    it('handles numeric values', () => {
      const result = interpolateCopy('{count} items', { count: 42 });
      expect(result).toBe('42 items');
    });

    it('XSS defense: does NOT auto-escape (caller wraps in JSX which auto-escapes)', () => {
      // Interpolation passes raw values. The React Email render
      // pipeline auto-escapes via JSX so HTML/script tags become
      // entity-encoded text, not executable.
      const result = interpolateCopy('Hello {firstName}', {
        firstName: '<script>alert(1)</script>',
      });
      // Raw interpolation kept; JSX render is responsible for escape.
      expect(result).toContain('<script>');
    });
  });
});
