/**
 * T062 — Sign-in policy: portal mismatch + role mapping.
 *
 * Pure unit tests against `expectedPortal()` and the
 * `PORTAL_FOR_ROLE` mapping that the sign-in use case uses to enforce
 * spec FR-016 ("invalid-credentials" is the same generic message
 * regardless of which check failed).
 */
import { describe, expect, it } from 'vitest';
import { expectedPortal } from '@/modules/auth/application/sign-in';
import { PORTAL_FOR_ROLE, ROLES } from '@/modules/auth/domain/role';

describe('sign-in portal policy', () => {
  it('admin → staff portal', () => {
    expect(expectedPortal('admin')).toBe('staff');
  });

  it('manager → staff portal', () => {
    expect(expectedPortal('manager')).toBe('staff');
  });

  it('member → member portal', () => {
    expect(expectedPortal('member')).toBe('member');
  });

  it('every Role has a portal mapping', () => {
    for (const role of ROLES) {
      expect(PORTAL_FOR_ROLE[role]).toBeDefined();
      expect(['staff', 'member']).toContain(PORTAL_FOR_ROLE[role]);
    }
  });

  it('portal mapping has no extra keys (defensive)', () => {
    expect(Object.keys(PORTAL_FOR_ROLE).sort()).toEqual([...ROLES].sort());
  });
});
