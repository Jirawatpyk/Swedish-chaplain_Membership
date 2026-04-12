import { describe, expect, it } from 'vitest';
import {
  asTenantContext,
  InvalidTenantSlugError,
  TENANT_SLUG_PATTERN,
  type TenantContext,
} from '@/modules/tenants';

describe('TenantContext', () => {
  describe('asTenantContext — happy path', () => {
    it('accepts a simple lowercase slug', () => {
      const ctx = asTenantContext('swecham');
      expect(ctx.slug).toBe('swecham');
    });

    it('accepts slugs with digits', () => {
      const ctx = asTenantContext('swecham2026');
      expect(ctx.slug).toBe('swecham2026');
    });

    it('accepts slugs with hyphens', () => {
      const ctx = asTenantContext('test-swecham');
      expect(ctx.slug).toBe('test-swecham');
    });

    it('accepts single-character slugs', () => {
      const ctx = asTenantContext('a');
      expect(ctx.slug).toBe('a');
    });

    it('accepts 63-character slugs (DNS label max)', () => {
      const slug = 'a'.repeat(63);
      const ctx = asTenantContext(slug);
      expect(ctx.slug).toBe(slug);
    });

    it('preserves branded type identity at the type level', () => {
      const ctx: TenantContext = asTenantContext('swecham');
      // Assign-ability is a compile-time brand check — this test proves the
      // type round-trips through the constructor with no widening.
      const roundTrip: TenantContext = ctx;
      expect(roundTrip.slug).toBe('swecham');
    });
  });

  describe('asTenantContext — rejections', () => {
    it('rejects empty string', () => {
      expect(() => asTenantContext('')).toThrow(InvalidTenantSlugError);
    });

    it('rejects slugs with uppercase letters', () => {
      expect(() => asTenantContext('SweCham')).toThrow(InvalidTenantSlugError);
    });

    it('rejects slugs with spaces', () => {
      expect(() => asTenantContext('swe cham')).toThrow(InvalidTenantSlugError);
    });

    it('rejects slugs with underscores', () => {
      expect(() => asTenantContext('swe_cham')).toThrow(InvalidTenantSlugError);
    });

    it('rejects slugs with dots', () => {
      expect(() => asTenantContext('swecham.org')).toThrow(InvalidTenantSlugError);
    });

    it('rejects slugs with slashes (path traversal defence)', () => {
      expect(() => asTenantContext('swecham/../admin')).toThrow(InvalidTenantSlugError);
    });

    it('rejects 64-character slugs (one past the max)', () => {
      const slug = 'a'.repeat(64);
      expect(() => asTenantContext(slug)).toThrow(InvalidTenantSlugError);
    });

    it('rejects leading-hyphen slugs? — actually ACCEPTS (pattern allows)', () => {
      // Document current behaviour: leading hyphen is allowed by [a-z0-9-]{1,63}.
      // If stricter validation is needed (e.g. DNS label rules: no leading/trailing
      // hyphen), tighten `SLUG_PATTERN` in tenant-context.ts and update this test.
      const ctx = asTenantContext('-swecham');
      expect(ctx.slug).toBe('-swecham');
    });

    it('rejects non-string inputs at runtime (defensive)', () => {
      // TypeScript prevents this at compile time but runtime callers at trust
      // boundaries (env, HTTP request params) can still pass non-strings.
      expect(() => asTenantContext(123 as unknown as string)).toThrow(
        InvalidTenantSlugError,
      );
      expect(() => asTenantContext(null as unknown as string)).toThrow(
        InvalidTenantSlugError,
      );
      expect(() => asTenantContext(undefined as unknown as string)).toThrow(
        InvalidTenantSlugError,
      );
    });

    it('error carries the attempted slug for diagnostics', () => {
      try {
        asTenantContext('BAD SLUG');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTenantSlugError);
        expect((err as InvalidTenantSlugError).attempted).toBe('BAD SLUG');
        expect((err as InvalidTenantSlugError).name).toBe('InvalidTenantSlugError');
      }
    });
  });

  describe('TENANT_SLUG_PATTERN', () => {
    it('is a re-exported RegExp that matches the constructor rule', () => {
      expect(TENANT_SLUG_PATTERN.test('swecham')).toBe(true);
      expect(TENANT_SLUG_PATTERN.test('SweCham')).toBe(false);
      expect(TENANT_SLUG_PATTERN.test('')).toBe(false);
    });
  });
});
