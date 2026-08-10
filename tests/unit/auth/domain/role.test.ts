import { describe, expect, it } from 'vitest';
import {
  isRole,
  isStaffRole,
  PORTAL_FOR_ROLE,
  ROLES,
  STAFF_ROLES,
} from '@/modules/auth/domain/role';

describe('ROLES constant', () => {
  it('contains exactly the five system roles (016-rbac-permissions FR-001)', () => {
    expect([...ROLES].sort()).toEqual(
      ['admin', 'manager', 'marketing', 'member', 'super_admin'].sort(),
    );
  });
});

describe('STAFF_ROLES', () => {
  it('contains all four staff roles, never member', () => {
    expect(STAFF_ROLES).toContain('super_admin');
    expect(STAFF_ROLES).toContain('admin');
    expect(STAFF_ROLES).toContain('manager');
    expect(STAFF_ROLES).toContain('marketing');
    expect(STAFF_ROLES).not.toContain('member');
  });
});

describe('PORTAL_FOR_ROLE', () => {
  it('maps every staff role to the staff portal', () => {
    expect(PORTAL_FOR_ROLE.super_admin).toBe('staff');
    expect(PORTAL_FOR_ROLE.admin).toBe('staff');
    expect(PORTAL_FOR_ROLE.manager).toBe('staff');
    expect(PORTAL_FOR_ROLE.marketing).toBe('staff');
  });

  it('maps member to member portal', () => {
    expect(PORTAL_FOR_ROLE.member).toBe('member');
  });
});

describe('isRole', () => {
  it('accepts valid roles', () => {
    expect(isRole('super_admin')).toBe(true);
    expect(isRole('admin')).toBe(true);
    expect(isRole('manager')).toBe(true);
    expect(isRole('marketing')).toBe(true);
    expect(isRole('member')).toBe(true);
  });

  it('rejects invalid strings', () => {
    expect(isRole('visitor')).toBe(false);
    expect(isRole('platform_admin')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole('ADMIN')).toBe(false);
  });
});

describe('isStaffRole', () => {
  it('super_admin, admin, manager, marketing are staff roles', () => {
    expect(isStaffRole('super_admin')).toBe(true);
    expect(isStaffRole('admin')).toBe(true);
    expect(isStaffRole('manager')).toBe(true);
    expect(isStaffRole('marketing')).toBe(true);
  });

  it('member is NOT a staff role', () => {
    expect(isStaffRole('member')).toBe(false);
  });
});
