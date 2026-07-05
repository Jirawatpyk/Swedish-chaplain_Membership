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
import {
  estimatePasswordStrength,
  weakReasonFor,
} from '@/components/auth/password-strength';

describe('estimatePasswordStrength', () => {
  it('returns "empty" for an empty string', () => {
    expect(estimatePasswordStrength('')).toBe('empty');
  });

  it('returns "weak" for passwords shorter than 12 characters', () => {
    expect(estimatePasswordStrength('short')).toBe('weak');
    expect(estimatePasswordStrength('1234567890')).toBe('weak'); // 10 chars
    expect(estimatePasswordStrength('12345678901')).toBe('weak'); // 11 chars
  });

  it('returns "acceptable" for 12-15 char passwords with < 3 character classes', () => {
    expect(estimatePasswordStrength('123456789012')).toBe('acceptable'); // 12, digits only (1 class)
    expect(estimatePasswordStrength('aVeryLongPass')).toBe('acceptable'); // 13, lower+upper (2 classes)
    expect(estimatePasswordStrength('123456789012345')).toBe('acceptable'); // 15, digits only (1 class)
  });

  // BUG-004: a genuinely "hard" 12-char password (mixed case + digit + symbol)
  // used to read only "acceptable" because the old rule demanded >= 16 chars
  // AND a symbol. It now reads "strong" via the >= 3 character-classes path.
  it('returns "strong" for a short (12-15 char) password with ≥3 character classes — BUG-004', () => {
    expect(estimatePasswordStrength('MyStr0ngP@ss')).toBe('strong'); // 12, lower+upper+digit+symbol (4)
    expect(estimatePasswordStrength('MyPassw0rd12')).toBe('strong'); // 12, lower+upper+digit (3)
    expect(estimatePasswordStrength('aB3xK9mZ2pQ7')).toBe('strong'); // 12, lower+upper+digit (3)
  });

  it('returns "strong" for ≥16 chars on length alone — no symbol required (BUG-004)', () => {
    // A long passphrase is strong regardless of character mix; the old rule
    // wrongly required a non-alphanumeric even at 16+ chars.
    expect(estimatePasswordStrength('abcdefghijklmnop')).toBe('strong'); // 16, lower only
    expect(estimatePasswordStrength('abc123def456ghi7890')).toBe('strong'); // 19, lower+digit
    expect(estimatePasswordStrength('abcdefghijklmno!')).toBe('strong'); // 16 + symbol
    expect(estimatePasswordStrength('correct horse battery staple')).toBe('strong'); // spaces
    expect(estimatePasswordStrength('Tr0ub4dor&3Correct')).toBe('strong');
    expect(estimatePasswordStrength('correct horse bat')).toBe('strong'); // 17 chars
    expect(estimatePasswordStrength('a b c d e f g h ')).toBe('strong'); // 16 with spaces
  });

  // UAT 2026-06-30: "111111111111" read "acceptable" then failed on submit
  // (HIBP-breached). The low-entropy guard runs BEFORE the strong check, so
  // even a 16-char all-same-char string is weak, not strong.
  it('returns "weak" for obvious low-entropy patterns regardless of length', () => {
    expect(estimatePasswordStrength('111111111111')).toBe('weak'); // 12 chars, 1 distinct
    expect(estimatePasswordStrength('aaaaaaaaaaaaaaaa')).toBe('weak'); // 16 chars, 1 distinct
    expect(estimatePasswordStrength('121212121212')).toBe('weak'); // 2 distinct chars
    expect(estimatePasswordStrength('112233112233')).toBe('weak'); // 3 distinct chars (lower edge of the ≤3 band)
  });

  it('pins the 3-vs-4-distinct low-entropy boundary: 4 distinct + 1 class is acceptable', () => {
    // 4 distinct chars clears the low-entropy guard, but a single character
    // class + < 16 chars keeps it "acceptable" (not strong).
    expect(estimatePasswordStrength('aabbccddaabb')).toBe('acceptable'); // 12 chars, 4 distinct, lower only
  });
});

describe('weakReasonFor', () => {
  it('returns null for inputs that are not weak (empty / acceptable / strong)', () => {
    expect(weakReasonFor('')).toBeNull();
    expect(weakReasonFor('aB3xK9mZ2pQ7')).toBeNull(); // strong (≥3 classes) — still non-weak
    expect(weakReasonFor('correct horse battery staple')).toBeNull(); // strong
  });

  it('returns "tooShort" for under-12-char passwords', () => {
    expect(weakReasonFor('short')).toBe('tooShort');
    expect(weakReasonFor('12345678901')).toBe('tooShort'); // 11 chars
  });

  it('returns "lowVariety" for long-but-low-entropy passwords', () => {
    expect(weakReasonFor('111111111111')).toBe('lowVariety'); // 1 distinct
    expect(weakReasonFor('121212121212')).toBe('lowVariety'); // 2 distinct
    expect(weakReasonFor('112233112233')).toBe('lowVariety'); // 3 distinct
  });

  it('prefers "tooShort" when a password is BOTH short and low-variety', () => {
    // "1111" is <12 AND 1-distinct; length is the more actionable hint.
    expect(weakReasonFor('1111')).toBe('tooShort');
  });
});
