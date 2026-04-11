/**
 * `estimatePasswordStrength` unit test.
 *
 * The function is extracted from 3 form components so threshold
 * changes live in one place. The file comment claims "matches the
 * server heuristic in scoreStrength" — this test pins the 4
 * reachable branches (empty / weak / acceptable / strong) so any
 * drift against the server function is caught early.
 */
import { describe, expect, it } from 'vitest';
import { estimatePasswordStrength } from '@/components/auth/password-strength';

describe('estimatePasswordStrength', () => {
  it('returns "empty" for an empty string', () => {
    expect(estimatePasswordStrength('')).toBe('empty');
  });

  it('returns "weak" for passwords shorter than 12 characters', () => {
    expect(estimatePasswordStrength('short')).toBe('weak');
    expect(estimatePasswordStrength('1234567890')).toBe('weak'); // 10 chars
    expect(estimatePasswordStrength('12345678901')).toBe('weak'); // 11 chars
  });

  it('returns "acceptable" for 12-15 character passwords', () => {
    expect(estimatePasswordStrength('123456789012')).toBe('acceptable'); // 12 chars
    expect(estimatePasswordStrength('aVeryLongPass')).toBe('acceptable'); // 13 chars
    expect(estimatePasswordStrength('123456789012345')).toBe('acceptable'); // 15 chars
  });

  it('returns "acceptable" for ≥16 chars without a non-alphanumeric', () => {
    // 16+ chars but only letters/digits → still acceptable, not strong
    expect(estimatePasswordStrength('abcdefghijklmnop')).toBe('acceptable');
    expect(estimatePasswordStrength('abc123def456ghi7890')).toBe('acceptable');
  });

  it('returns "strong" for ≥16 chars WITH at least one non-alphanumeric', () => {
    expect(estimatePasswordStrength('abcdefghijklmno!')).toBe('strong'); // 16 chars + symbol
    expect(estimatePasswordStrength('correct horse battery staple')).toBe('strong'); // has spaces
    expect(estimatePasswordStrength('Tr0ub4dor&3Correct')).toBe('strong');
  });

  it('treats space as a non-alphanumeric symbol', () => {
    // XKCD-style passphrases rely on spaces for entropy. The space
    // matches `[^a-zA-Z0-9]`, so 16+ chars with at least one space
    // is strong.
    expect(estimatePasswordStrength('correct horse bat')).toBe('strong'); // 17 chars
    expect(estimatePasswordStrength('a b c d e f g h ')).toBe('strong'); // 16 chars with spaces
  });
});
