/**
 * `estimatePasswordStrength` unit test.
 *
 * The function is extracted from 3 form components so threshold
 * changes live in one place. The client estimator deliberately
 * APPROXIMATES — and for low-entropy inputs is intentionally STRICTER
 * than — the server `scoreStrength` (the server has no entropy check).
 * This test pins the 4 reachable branches (empty / weak / acceptable /
 * strong) plus the low-entropy guard and its 3-vs-4-distinct boundary,
 * so any unintended drift is caught early.
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

  // UAT 2026-06-30: "111111111111" read "acceptable" then failed on submit
  // (HIBP-breached). The bar now flags obvious low-entropy junk locally.
  it('returns "weak" for obvious low-entropy patterns regardless of length', () => {
    expect(estimatePasswordStrength('111111111111')).toBe('weak'); // 12 chars, 1 distinct
    expect(estimatePasswordStrength('aaaaaaaaaaaaaaaa')).toBe('weak'); // 16 chars, 1 distinct — would be "acceptable" by length alone (alnum, no symbol)
    expect(estimatePasswordStrength('121212121212')).toBe('weak'); // 2 distinct chars
    expect(estimatePasswordStrength('112233112233')).toBe('weak'); // 3 distinct chars (lower edge of the ≤3 band)
  });

  it('pins the 3-vs-4-distinct boundary: exactly 4 distinct chars is acceptable', () => {
    // The guard is `Set(password).size <= 3`, so the flip-point sits between 3
    // and 4 distinct chars. Asserting the 4-distinct side catches a one-off
    // regression of the threshold (e.g. <= 4 surviving the suite).
    expect(estimatePasswordStrength('aabbccddaabb')).toBe('acceptable'); // 12 chars, 4 distinct
  });

  it('does NOT flag a >3-distinct-char password as low-entropy', () => {
    // 12 distinct chars and NOT in the server COMMON_PASSWORDS list, so the
    // client stays "acceptable" and only the server's HIBP check could still
    // reject it on submit (the genuine client/server drift case).
    expect(estimatePasswordStrength('aB3xK9mZ2pQ7')).toBe('acceptable');
  });
});
