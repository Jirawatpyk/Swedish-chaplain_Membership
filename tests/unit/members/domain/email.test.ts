import { describe, expect, it } from 'vitest';
import { asEmail, isEmail } from '@/modules/members/domain/value-objects/email';

describe('Email value object', () => {
  it('accepts a well-formed email and normalizes to lowercase', () => {
    const r = asEmail('First.Last@Example.COM');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('first.last@example.com');
  });

  it('trims whitespace', () => {
    const r = asEmail('  user@example.com  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('user@example.com');
  });

  it('rejects empty', () => {
    const r = asEmail('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('email.empty');
  });

  it('rejects >254 chars', () => {
    const long = 'a'.repeat(250) + '@b.co'; // 256 chars
    const r = asEmail(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('email.too_long');
  });

  it('rejects malformed (no @)', () => {
    const r = asEmail('not-an-email');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('email.invalid_format');
  });

  it('rejects malformed (no TLD)', () => {
    const r = asEmail('user@localhost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('email.invalid_format');
  });

  it('isEmail type-guard', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('no')).toBe(false);
    expect(isEmail(123)).toBe(false);
  });
});
