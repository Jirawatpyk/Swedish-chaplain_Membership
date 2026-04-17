import { describe, expect, it } from 'vitest';
import { asUserId } from '@/modules/members/domain/value-objects/user-id';

describe('UserId (opaque brand)', () => {
  it('accepts a valid UUID (lowercase)', () => {
    const r = asUserId('11111111-2222-3333-4444-555555555555');
    expect(r.ok).toBe(true);
  });

  it('normalizes to lowercase', () => {
    const r = asUserId('ABCDEF12-3456-7890-ABCD-EF1234567890');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('abcdef12-3456-7890-abcd-ef1234567890');
  });

  it('rejects non-UUID', () => {
    const r = asUserId('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('userId.invalid_uuid');
  });

  it('rejects UUID with bad length', () => {
    const r = asUserId('11111111-2222-3333-4444-55555');
    expect(r.ok).toBe(false);
  });
});
