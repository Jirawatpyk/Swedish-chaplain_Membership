/**
 * T040 — Unit tests for the F7 EmailLower VO.
 *
 * Verifies lowercase + trim normalisation, format-validity checks,
 * length cap (≤254 chars). Returned values are branded `EmailLower`
 * strings — type guard `isEmailLower` confirms.
 */
import { describe, expect, it } from 'vitest';
import { asEmailLower, isEmailLower } from '@/modules/broadcasts';

describe('asEmailLower normalisation', () => {
  it('lowercases mixed-case input', () => {
    const result = asEmailLower('User@Example.COM');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    const result = asEmailLower('  alice@example.com  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('alice@example.com');
  });

  it('combines lowercase + trim', () => {
    const result = asEmailLower('  ALICE@Example.com  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('alice@example.com');
  });

  it('preserves valid characters in local part (._%+-)', () => {
    const result = asEmailLower('alice.bob_test+tag-1@example.com');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toBe('alice.bob_test+tag-1@example.com');
  });

  it('preserves dots + hyphens in domain', () => {
    const result = asEmailLower('a@sub-domain.example.co.th');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('a@sub-domain.example.co.th');
  });
});

describe('asEmailLower validation errors', () => {
  it('rejects empty string', () => {
    const result = asEmailLower('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('email_lower.empty');
  });

  it('rejects whitespace-only', () => {
    const result = asEmailLower('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('email_lower.empty');
  });

  it('rejects no @', () => {
    const result = asEmailLower('alice.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('email_lower.invalid_format');
  });

  it('rejects missing TLD', () => {
    const result = asEmailLower('alice@example');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('email_lower.invalid_format');
  });

  it('rejects single-letter TLD', () => {
    const result = asEmailLower('alice@example.a');
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('email_lower.invalid_format');
  });

  it('rejects too long (≥ 255 chars after trim)', () => {
    const longLocal = 'a'.repeat(245);
    const result = asEmailLower(`${longLocal}@example.com`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('email_lower.too_long');
  });
});

describe('isEmailLower type guard', () => {
  it('true for valid email string', () => {
    expect(isEmailLower('alice@example.com')).toBe(true);
  });

  it('false for invalid email string', () => {
    expect(isEmailLower('not-an-email')).toBe(false);
  });

  it('false for non-string input', () => {
    expect(isEmailLower(42)).toBe(false);
    expect(isEmailLower(null)).toBe(false);
    expect(isEmailLower(undefined)).toBe(false);
    expect(isEmailLower({ email: 'a@b.com' })).toBe(false);
  });
});

describe('determinism', () => {
  it('returns identical normalised value across multiple calls', () => {
    const r1 = asEmailLower('Alice@Example.COM');
    const r2 = asEmailLower('Alice@Example.COM');
    expect(r1.ok && r2.ok && r1.value === r2.value).toBe(true);
  });
});
