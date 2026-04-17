import { describe, expect, it } from 'vitest';
import { asContactId, isPreferredLanguage } from '@/modules/members/domain/contact';

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

