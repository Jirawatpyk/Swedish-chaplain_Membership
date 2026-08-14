import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_ROLES,
  byDisplayOrder,
  isRole,
  isStaffRole,
  PORTAL_FOR_ROLE,
  ROLES,
  STAFF_ROLES,
  type Role,
} from '@/modules/auth/domain/role';
import { roleEnum } from '@/modules/auth/infrastructure/db/schema';

describe('ROLES constant', () => {
  it('contains exactly the five system roles (016-rbac-permissions FR-001)', () => {
    expect([...ROLES].sort()).toEqual(
      ['admin', 'manager', 'marketing', 'member', 'super_admin'].sort(),
    );
  });

  it('is ORDER-EXACT — the tuple must match the live pg_enum label order', () => {
    // `ALTER TYPE … ADD VALUE` appends, so migration 0285's labels follow the
    // original three. Both role.ts and schema.ts document "never reorder";
    // this is the assertion that makes the contract fail loudly.
    expect([...ROLES]).toEqual(['admin', 'manager', 'member', 'super_admin', 'marketing']);
  });

  it('the Drizzle roleEnum tuple matches ROLES label-for-label and in order', () => {
    expect([...roleEnum.enumValues]).toEqual([...ROLES]);
  });
});

describe('ASSIGNABLE_ROLES (staged assignability)', () => {
  it('is fully open after PR 4 — every role in ROLES is assignable (D17 complete)', () => {
    // The staging is finished: super_admin landed in PR 3 (users-page retrofit),
    // marketing in PR 4 (design D17). Order is append-at-end, matching the
    // widening history, and it is asserted EXACTLY so a reorder is a visible
    // diff rather than a silent one. Widening this WITHOUT widening the invite
    // and change-role zod enums (and vice versa) is the defect
    // assignable-roles-lockstep.test.ts pins.
    expect([...ASSIGNABLE_ROLES]).toEqual([
      'admin',
      'manager',
      'member',
      'super_admin',
      'marketing',
    ]);
  });

  it('now covers every role — the staged-assignability window is closed', () => {
    // Once this is true, ASSIGNABLE_ROLES has no filtering job left. It is kept
    // because the lockstep test uses it as the single source the two route zod
    // enums must agree with; PR 5 may collapse it into ROLES.
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([...ROLES].sort());
  });

  it('is a subset of ROLES', () => {
    for (const role of ASSIGNABLE_ROLES) expect(ROLES).toContain(role);
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

describe('byDisplayOrder', () => {
  it('sorts most-privileged first regardless of input order', () => {
    expect(byDisplayOrder(['member', 'marketing', 'super_admin', 'admin', 'manager'])).toEqual([
      'super_admin',
      'admin',
      'manager',
      'marketing',
      'member',
    ]);
  });

  it('an unknown role sorts LAST rather than throwing or floating to the top', () => {
    // The defensive `-1 → length` arm: a future role that has not yet been
    // added to ROLE_DISPLAY_ORDER must degrade to "after everything ranked",
    // never to position 0 (which would present it as most privileged).
    expect(byDisplayOrder(['future_role' as Role, 'member', 'admin'])).toEqual([
      'admin',
      'member',
      'future_role',
    ]);
  });
});
