/**
 * review-20260428-102639.md W16 closure — locks the contract that
 * `formatSatangThb` ALWAYS suffixes "THB" regardless of locale, so
 * SV / EN / TH renderings of a Thai-baht amount stay consistent and
 * never localise the currency code (e.g. to "kr" for sv-SE which
 * would be a Thai-tax-compliance bug).
 */
import { describe, expect, it } from 'vitest';
import { formatSatangThb } from '@/lib/format-thb';

describe('formatSatangThb', () => {
  it('returns "—" for null', () => {
    expect(formatSatangThb(null)).toBe('—');
  });

  it('formats positive satang with THB suffix (en-US default)', () => {
    expect(formatSatangThb(123_456n)).toBe('1,234.56 THB');
  });

  it('formats negative satang with leading sign + THB suffix', () => {
    // BigInt remainder edge-case: -3434n % 100n = -34n; we render as
    // `-34.34 THB`, not `0.-34 THB`.
    expect(formatSatangThb(-3434n)).toBe('-34.34 THB');
  });

  it('keeps THB suffix on sv-SE — must NOT localise to "kr"', () => {
    // SC: Thai tax invoice in SV locale; currency code stays "THB".
    expect(formatSatangThb(1_070_000n, 'sv-SE')).toMatch(/THB$/);
    expect(formatSatangThb(1_070_000n, 'sv-SE')).not.toContain('kr');
  });

  it('keeps THB suffix on th-TH — must NOT localise to "฿" symbol', () => {
    expect(formatSatangThb(1_070_000n, 'th-TH')).toMatch(/THB$/);
    expect(formatSatangThb(1_070_000n, 'th-TH')).not.toContain('฿');
  });

  it('honours locale for thousands grouping while keeping THB suffix', () => {
    // sv-SE uses non-breaking-space or thin-space for thousands; en-US
    // uses comma. Either way, the trailing "THB" is constant.
    const sv = formatSatangThb(123_456_789n, 'sv-SE');
    const en = formatSatangThb(123_456_789n, 'en-US');
    expect(sv).toMatch(/THB$/);
    expect(en).toMatch(/THB$/);
    expect(en).toContain(',');
  });

  // Portal callers pass the raw next-intl locale ('en' | 'th' | 'sv').
  // Swedish writes the decimal mark as a comma ("36 000,00"), so the
  // decimal separator must follow the locale, not a hardcoded ".".
  it('uses the Swedish decimal comma on sv', () => {
    expect(formatSatangThb(3_600_000n, 'sv')).toBe('36\u00a0000,00 THB');
    expect(formatSatangThb(3_600_000n, 'sv-SE')).toBe('36\u00a0000,00 THB');
  });

  it('keeps the decimal point on th and en', () => {
    expect(formatSatangThb(3_600_000n, 'th')).toBe('36,000.00 THB');
    expect(formatSatangThb(3_600_000n, 'en')).toBe('36,000.00 THB');
  });

  it('keeps exact satang precision on sv (no float rounding)', () => {
    expect(formatSatangThb(1n, 'sv')).toBe('0,01 THB');
    expect(formatSatangThb(-3434n, 'sv')).toBe('-34,34 THB');
    // Beyond Number.MAX_SAFE_INTEGER satang — must not lose digits.
    expect(formatSatangThb(9_007_199_254_740_993n, 'en')).toBe(
      '90,071,992,547,409.93 THB',
    );
  });
});
