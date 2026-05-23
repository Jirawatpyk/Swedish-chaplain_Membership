import { describe, expect, it } from 'vitest';
import {
  asContactId,
  contactPrimacy,
  isPreferredLanguage,
  tryContactId,
} from '@/modules/members/domain/contact';

describe('contactPrimacy — discriminated-union narrowing (M5)', () => {
  const at = new Date('2026-04-15T00:00:00Z');

  it('primary → { isPrimary: true, removedAt: null }', () => {
    expect(contactPrimacy(true, null)).toEqual({
      isPrimary: true,
      removedAt: null,
    });
  });

  it('non-primary active → { isPrimary: false, removedAt: null }', () => {
    expect(contactPrimacy(false, null)).toEqual({
      isPrimary: false,
      removedAt: null,
    });
  });

  it('non-primary removed → { isPrimary: false, removedAt }', () => {
    expect(contactPrimacy(false, at)).toEqual({
      isPrimary: false,
      removedAt: at,
    });
  });

  it('throws on the DB-invariant violation primary + removed', () => {
    expect(() => contactPrimacy(true, at)).toThrow(
      /primary contact cannot be removed/,
    );
  });
});

describe('isPreferredLanguage', () => {
  it('accepts en / th / sv', () => {
    expect(isPreferredLanguage('en')).toBe(true);
    expect(isPreferredLanguage('th')).toBe(true);
    expect(isPreferredLanguage('sv')).toBe(true);
  });
  it('rejects others', () => {
    expect(isPreferredLanguage('fr')).toBe(false);
    expect(isPreferredLanguage(null)).toBe(false);
    expect(isPreferredLanguage(42)).toBe(false);
  });
});

describe('asContactId', () => {
  it('brands a raw string as ContactId', () => {
    const id = asContactId('c-001');
    expect(id).toBe('c-001');
  });
});

describe('tryContactId', () => {
  it('returns ok for a valid UUID', () => {
    const result = tryContactId('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('normalises to lowercase', () => {
    const result = tryContactId('A1B2C3D4-E5F6-7890-ABCD-EF1234567890');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('returns err for a non-UUID string', () => {
    const result = tryContactId('not-a-uuid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_contact_id');
  });

  it('returns err for null / number / undefined', () => {
    expect(tryContactId(null).ok).toBe(false);
    expect(tryContactId(42).ok).toBe(false);
    expect(tryContactId(undefined).ok).toBe(false);
  });
});

