import { describe, expect, it } from 'vitest';
import {
  asIsoCountryCode,
  isIsoCountryCode,
} from '@/modules/members/domain/value-objects/iso-country-code';

describe('IsoCountryCode value object', () => {
  it.each(['TH', 'SE', 'US', 'JP'])('accepts %s', (code) => {
    const r = asIsoCountryCode(code);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(code);
  });

  it('uppercases + trims', () => {
    const r = asIsoCountryCode(' th ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('TH');
  });

  it('rejects wrong length', () => {
    const r = asIsoCountryCode('THA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('country.wrong_length');
  });

  it('rejects single char', () => {
    const r = asIsoCountryCode('T');
    expect(r.ok).toBe(false);
  });

  it('rejects nonsense 2-char code', () => {
    const r = asIsoCountryCode('ZZ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('country.invalid');
  });

  it('isIsoCountryCode type-guard', () => {
    expect(isIsoCountryCode('TH')).toBe(true);
    expect(isIsoCountryCode('XX')).toBe(false);
    expect(isIsoCountryCode(null)).toBe(false);
  });
});
