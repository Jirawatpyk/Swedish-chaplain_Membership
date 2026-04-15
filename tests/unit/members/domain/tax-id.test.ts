import { describe, expect, it } from 'vitest';
import { asTaxId } from '@/modules/members/domain/value-objects/tax-id';
import type { IsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code';

const TH = 'TH' as IsoCountryCode;
const SE = 'SE' as IsoCountryCode;

describe('TaxId — Thailand (13-digit + checksum)', () => {
  it('accepts a valid Thai tax ID with correct checksum', () => {
    // 1234567890121 — handcrafted: sum = 1*13 + 2*12 + 3*11 + 4*10 + 5*9 + 6*8 + 7*7 + 8*6 + 9*5 + 0*4 + 1*3 + 2*2 = 13+24+33+40+45+48+49+48+45+0+3+4 = 352; 352 mod 11 = 0; (11-0) mod 10 = 1 → check digit 1
    const r = asTaxId('1234567890121', TH);
    expect(r.ok).toBe(true);
  });

  it('rejects Thai ID with wrong checksum', () => {
    const r = asTaxId('1234567890122', TH); // last digit wrong
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('taxId.th_bad_checksum');
  });

  it('rejects non-digit Thai ID', () => {
    const r = asTaxId('1234A67890121', TH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('taxId.th_wrong_format');
  });

  it('rejects 12-digit Thai ID (wrong length)', () => {
    const r = asTaxId('123456789012', TH);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('taxId.th_wrong_format');
  });
});

describe('TaxId — generic (non-Thai, length-only)', () => {
  it('accepts a Swedish org number format', () => {
    const r = asTaxId('556123-4567', SE);
    expect(r.ok).toBe(true);
  });

  it('rejects empty', () => {
    const r = asTaxId('   ', SE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('taxId.empty');
  });

  it('rejects >50 chars', () => {
    const r = asTaxId('x'.repeat(51), SE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('taxId.too_long');
  });
});
