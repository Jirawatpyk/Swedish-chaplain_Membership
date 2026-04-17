import { describe, expect, it } from 'vitest';
import {
  isRole,
  isStaffRole,
  PORTAL_FOR_ROLE,
  ROLES,
  STAFF_ROLES,
} from '@/modules/auth/domain/role';

describe('ROLES constant', () => {
  it('contains exactly admin, manager, member', () => {
    expect([...ROLES].sort()).toEqual(['admin', 'manager', 'member']);
  });
});

describe('STAFF_ROLES', () => {
  it('contains admin and manager', () => {
    expect(STAFF_ROLES).toContain('admin');
    expect(STAFF_ROLES).toContain('manager');
    expect(STAFF_ROLES).not.toContain('member');
  });
});

describe('PORTAL_FOR_ROLE', () => {
  it('maps admin and manager to staff portal', () => {
    expect(PORTAL_FOR_ROLE.admin).toBe('staff');
    expect(PORTAL_FOR_ROLE.manager).toBe('staff');
  });

  it('maps member to member portal', () => {
    expect(PORTAL_FOR_ROLE.member).toBe('member');
  });
});

describe('isRole', () => {
  it('accepts valid roles', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('manager')).toBe(true);
    expect(isRole('member')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isRole('visitor')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole('ADMIN')).toBe(false);
  });
});

describe('isStaffRole', () => {
  it('admin is a staff role', () => {
    expect(isStaffRole('admin')).toBe(true);
  });

  it('manager is a staff role', () => {
    expect(isStaffRole('manager')).toBe(true);
  });

  it('member is NOT a staff role', () => {
    expect(isStaffRole('member')).toBe(false);
  });
});
