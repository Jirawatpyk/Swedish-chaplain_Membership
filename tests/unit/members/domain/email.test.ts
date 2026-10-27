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

  // 134-s1 — the erasure sentinel domain (RFC 6761 reserved) is never a real
  // address; accepting it would let a person's address collide with an
  // erased login's tombstone.
  it.each(['someone@erased.invalid', 'erased+abc@ERASED.INVALID', 'x@sub.erased.invalid'])(
    'rejects the erasure sentinel domain (%s)',
    (raw) => {
      const r = asEmail(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('email.reserved_domain');
    },
  );

  it('still accepts a domain that only contains the sentinel text', () => {
    expect(asEmail('someone@noterased.invalid.example.com').ok).toBe(true);
  });

  it('isEmail type-guard', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('no')).toBe(false);
    expect(isEmail(123)).toBe(false);
  });
});
