import { describe, expect, it } from 'vitest';
import { asPhone, isPhone } from '@/modules/members/domain/value-objects/phone';

describe('Phone value object', () => {
  it('accepts Thai mobile E.164', () => {
    const r = asPhone('+66812345678');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('+66812345678');
  });

  it('strips spaces, hyphens, parens before validation', () => {
    const r = asPhone('+66 (81) 234-5678');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('+66812345678');
  });

  it('rejects empty', () => {
    const r = asPhone('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('phone.empty');
  });

  it('rejects missing leading +', () => {
    const r = asPhone('66812345678');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('phone.invalid_format');
  });

  it('rejects leading 0 after +', () => {
    const r = asPhone('+0812345678');
    expect(r.ok).toBe(false);
  });

  it('rejects too short (7 digits after +)', () => {
    const r = asPhone('+1234567');
    expect(r.ok).toBe(false);
  });

  it('rejects too long (16 digits after +)', () => {
    const r = asPhone('+1234567890123456');
    expect(r.ok).toBe(false);
  });

  it('isPhone type-guard', () => {
    expect(isPhone('+46701234567')).toBe(true);
    expect(isPhone('123')).toBe(false);
    expect(isPhone(null)).toBe(false);
  });
});
