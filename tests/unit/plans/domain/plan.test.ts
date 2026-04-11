import { describe, expect, it } from 'vitest';
import {
  asPlanSlug,
  asPlanYear,
  asTenantSlug,
  isMemberTypeScope,
  isPlanCategory,
  MEMBER_TYPE_SCOPES,
  PLAN_CATEGORIES,
} from '@/modules/plans/domain/plan';

describe('Plan domain branded types', () => {
  describe('asPlanSlug', () => {
    it('accepts valid slugs', () => {
      expect(asPlanSlug('premium')).toBe('premium');
      expect(asPlanSlug('start-up')).toBe('start-up');
      expect(asPlanSlug('plan2026')).toBe('plan2026');
    });

    it('rejects empty string', () => {
      expect(() => asPlanSlug('')).toThrow(/Invalid plan slug/);
    });

    it('rejects uppercase', () => {
      expect(() => asPlanSlug('Premium')).toThrow(/Invalid plan slug/);
    });

    it('rejects >63 chars', () => {
      expect(() => asPlanSlug('a'.repeat(64))).toThrow(/Invalid plan slug/);
    });

    it('rejects non-string input', () => {
      expect(() => asPlanSlug(123 as unknown as string)).toThrow(/Invalid plan slug/);
    });
  });

  describe('asPlanYear', () => {
    it('accepts valid years', () => {
      expect(asPlanYear(2026)).toBe(2026);
      expect(asPlanYear(2000)).toBe(2000);
      expect(asPlanYear(2100)).toBe(2100);
    });

    it('rejects non-integer', () => {
      expect(() => asPlanYear(2026.5)).toThrow(/Invalid plan year/);
    });

    it('rejects out-of-range years', () => {
      expect(() => asPlanYear(1999)).toThrow(/Invalid plan year/);
      expect(() => asPlanYear(2101)).toThrow(/Invalid plan year/);
    });

    it('rejects NaN / Infinity', () => {
      expect(() => asPlanYear(Number.NaN)).toThrow(/Invalid plan year/);
      expect(() => asPlanYear(Number.POSITIVE_INFINITY)).toThrow(/Invalid plan year/);
    });
  });

  describe('asTenantSlug', () => {
    it('accepts valid slugs', () => {
      expect(asTenantSlug('swecham')).toBe('swecham');
      expect(asTenantSlug('test-chamber')).toBe('test-chamber');
    });

    it('rejects invalid slugs', () => {
      expect(() => asTenantSlug('')).toThrow();
      expect(() => asTenantSlug('SWE')).toThrow();
      expect(() => asTenantSlug('a'.repeat(64))).toThrow();
    });
  });

  describe('enum exhaustiveness', () => {
    it('PLAN_CATEGORIES contains exactly corporate + partnership', () => {
      expect([...PLAN_CATEGORIES].sort()).toEqual(['corporate', 'partnership']);
    });

    it('MEMBER_TYPE_SCOPES contains exactly company + individual + both', () => {
      expect([...MEMBER_TYPE_SCOPES].sort()).toEqual(['both', 'company', 'individual']);
    });

    it('isPlanCategory narrows correctly', () => {
      expect(isPlanCategory('corporate')).toBe(true);
      expect(isPlanCategory('partnership')).toBe(true);
      expect(isPlanCategory('other')).toBe(false);
      expect(isPlanCategory(123)).toBe(false);
      expect(isPlanCategory(null)).toBe(false);
    });

    it('isMemberTypeScope narrows correctly', () => {
      expect(isMemberTypeScope('company')).toBe(true);
      expect(isMemberTypeScope('individual')).toBe(true);
      expect(isMemberTypeScope('both')).toBe(true);
      expect(isMemberTypeScope('COMPANY')).toBe(false);
      expect(isMemberTypeScope(undefined)).toBe(false);
    });
  });
});
