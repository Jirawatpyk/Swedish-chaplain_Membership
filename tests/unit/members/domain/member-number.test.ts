import { describe, expect, it } from 'vitest';
import {
  asMemberNumber,
  formatMemberNumber,
  parseMemberNumberQuery,
  InvalidMemberNumberError,
  type MemberNumber,
} from '@/modules/members/domain/value-objects/member-number';

describe('asMemberNumber — branded positive-integer constructor', () => {
  it('accepts a positive integer and returns it branded', () => {
    const n = asMemberNumber(42);
    // brand is compile-time only; at runtime the value is the plain number
    expect(n).toBe(42);
  });

  it('accepts 1 (lower boundary)', () => {
    expect(asMemberNumber(1)).toBe(1);
  });

  it('rejects 0 with InvalidMemberNumberError', () => {
    expect(() => asMemberNumber(0)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a negative integer (-1)', () => {
    expect(() => asMemberNumber(-1)).toThrow(InvalidMemberNumberError);
  });

  it('rejects a non-integer (1.5)', () => {
    expect(() => asMemberNumber(1.5)).toThrow(InvalidMemberNumberError);
  });

  it('rejects NaN', () => {
    expect(() => asMemberNumber(Number.NaN)).toThrow(InvalidMemberNumberError);
  });

  it('error carries the offending value for diagnostics', () => {
    try {
      asMemberNumber(0);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidMemberNumberError);
      expect((e as InvalidMemberNumberError).value).toBe(0);
    }
  });
});

describe('formatMemberNumber — {prefix}-{zeroPad}', () => {
  it('pads to width 4 by default (SCCM-0042)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(42))).toBe('SCCM-0042');
  });

  it('pads a single digit (M-0001)', () => {
    expect(formatMemberNumber('M', asMemberNumber(1))).toBe('M-0001');
  });

  it('renders an exact-width number without extra padding (SCCM-9999)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(9999))).toBe('SCCM-9999');
  });

  it('auto-expands past the pad width (SCCM-10000, no truncation)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(10000))).toBe('SCCM-10000');
  });

  it('auto-expands far past the pad width (SCCM-123456)', () => {
    expect(formatMemberNumber('SCCM', asMemberNumber(123456))).toBe('SCCM-123456');
  });

  it('honours an explicit pad override', () => {
    expect(formatMemberNumber('M', asMemberNumber(42), 6)).toBe('M-000042');
  });
});

describe('parseMemberNumberQuery — search-box parser → integer | null', () => {
  it('parses a fully-formatted number (SCCM-0042 → 42)', () => {
    expect(parseMemberNumberQuery('SCCM-0042')).toBe(42);
  });

  it('parses a zero-padded bare number (0042 → 42)', () => {
    expect(parseMemberNumberQuery('0042')).toBe(42);
  });

  it('parses a bare number (42 → 42)', () => {
    expect(parseMemberNumberQuery('42')).toBe(42);
  });

  it('trims surrounding whitespace ("  SCCM-0042  " → 42)', () => {
    expect(parseMemberNumberQuery('  SCCM-0042  ')).toBe(42);
  });

  it('is case-insensitive on the prefix (sccm-0042 → 42)', () => {
    expect(parseMemberNumberQuery('sccm-0042')).toBe(42);
  });

  it('returns null for an empty string', () => {
    expect(parseMemberNumberQuery('')).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(parseMemberNumberQuery('   ')).toBeNull();
  });

  it('returns null for prefix-only (SCCM-)', () => {
    expect(parseMemberNumberQuery('SCCM-')).toBeNull();
  });

  it('returns null for a negative number (-1)', () => {
    expect(parseMemberNumberQuery('-1')).toBeNull();
  });

  it('returns null for zero (0)', () => {
    expect(parseMemberNumberQuery('0')).toBeNull();
  });

  it('returns null for zero-padded zero (0000)', () => {
    expect(parseMemberNumberQuery('0000')).toBeNull();
  });

  it('returns null for a non-numeric query (NOT-A-NUMBER)', () => {
    expect(parseMemberNumberQuery('NOT-A-NUMBER')).toBeNull();
  });

  it('returns null for a bare non-numeric token (x)', () => {
    expect(parseMemberNumberQuery('x')).toBeNull();
  });
});
