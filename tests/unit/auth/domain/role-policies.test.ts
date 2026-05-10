/**
 * T027 — Role-based access control unit tests.
 *
 * Covers every (role × resource × action) combination relevant to F1
 * (spec Q4 / FR-003). Constitution Principle II requires 100% branch
 * coverage on this file (security-critical path — vitest.config.ts
 * `src/modules/auth/domain/**` overrides).
 */
import { describe, expect, it } from 'vitest';
import { canAccess, isReadOnlyRole, SELF_RESOURCE } from '@/modules/auth/domain/policies';
import { ROLES, type Role } from '@/modules/auth/domain/role';

const ACTIONS = ['read', 'write', 'delete', 'admin', 'clone'] as const;
const NON_SELF_RESOURCES = [
  'auth:user',
  'auth:audit',
  'staff:dashboard',
  'member:portal',
  'invoices:invoice',
  'unknown:thing',
  // F2 additions (002-membership-plans)
  'plan',
  'fee_config',
] as const;

describe('canAccess — admin role', () => {
  it.each(ACTIONS)('allows admin %s on every resource', (action) => {
    for (const resource of NON_SELF_RESOURCES) {
      expect(canAccess('admin', resource, action)).toBe(true);
    }
    expect(canAccess('admin', SELF_RESOURCE, action)).toBe(action === 'read' || action === 'write');
  });
});

describe('canAccess — manager role (spec Q4: read-only everywhere except self)', () => {
  it.each(NON_SELF_RESOURCES)('permits manager READ on %s', (resource) => {
    expect(canAccess('manager', resource, 'read')).toBe(true);
  });

  it.each(NON_SELF_RESOURCES)('forbids manager WRITE on %s', (resource) => {
    expect(canAccess('manager', resource, 'write')).toBe(false);
  });

  it.each(NON_SELF_RESOURCES)('forbids manager DELETE on %s', (resource) => {
    expect(canAccess('manager', resource, 'delete')).toBe(false);
  });

  it.each(NON_SELF_RESOURCES)('forbids manager ADMIN on %s', (resource) => {
    expect(canAccess('manager', resource, 'admin')).toBe(false);
  });

  it('permits manager self-service write (own password change)', () => {
    expect(canAccess('manager', SELF_RESOURCE, 'write')).toBe(true);
  });
});

describe('canAccess — member role', () => {
  it('allows reading member: resources', () => {
    expect(canAccess('member', 'member:portal', 'read')).toBe(true);
    expect(canAccess('member', 'member:profile', 'read')).toBe(true);
  });

  it('forbids reading staff or audit resources', () => {
    expect(canAccess('member', 'staff:dashboard', 'read')).toBe(false);
    expect(canAccess('member', 'auth:audit', 'read')).toBe(false);
    expect(canAccess('member', 'auth:user', 'read')).toBe(false);
  });

  it('forbids member writes anywhere except self', () => {
    expect(canAccess('member', 'member:portal', 'write')).toBe(false);
    expect(canAccess('member', 'auth:user', 'write')).toBe(false);
  });

  it('permits member self-service write (own password change)', () => {
    expect(canAccess('member', SELF_RESOURCE, 'write')).toBe(true);
  });

  it('forbids member delete + admin actions everywhere', () => {
    for (const resource of NON_SELF_RESOURCES) {
      expect(canAccess('member', resource, 'delete')).toBe(false);
      expect(canAccess('member', resource, 'admin')).toBe(false);
    }
  });

  // R11 coverage closure — member role on own-scoped F3+F7 resources.
  it('permits member read/write on members:own (F3 self-service)', () => {
    expect(canAccess('member', 'members:own', 'read')).toBe(true);
    expect(canAccess('member', 'members:own', 'write')).toBe(true);
  });

  it('permits member read/write on contacts:own (F3 self-service)', () => {
    expect(canAccess('member', 'contacts:own', 'read')).toBe(true);
    expect(canAccess('member', 'contacts:own', 'write')).toBe(true);
  });

  it('forbids member delete on members:own / contacts:own', () => {
    expect(canAccess('member', 'members:own', 'delete')).toBe(false);
    expect(canAccess('member', 'contacts:own', 'delete')).toBe(false);
  });

  it('permits member compose+submit+read+delete on broadcast:own (F7 self-service)', () => {
    expect(canAccess('member', 'broadcast:own', 'read')).toBe(true);
    expect(canAccess('member', 'broadcast:own', 'write')).toBe(true);
    expect(canAccess('member', 'broadcast:own', 'delete')).toBe(true);
  });

  it('forbids member admin on broadcast:own', () => {
    expect(canAccess('member', 'broadcast:own', 'admin')).toBe(false);
  });
});

describe('canAccess — members:bulk (F3 admin-only)', () => {
  // R11 coverage closure — pin the admin/manager bulk-action branches
  // explicitly so a future RBAC drift around bulk archive / bulk
  // status-change surfaces here rather than in production audit logs.

  it('admin: write on members:bulk → allow', () => {
    expect(canAccess('admin', 'members:bulk', 'write')).toBe(true);
  });

  it('admin: read/delete/admin on members:bulk → deny (only write is meaningful)', () => {
    expect(canAccess('admin', 'members:bulk', 'read')).toBe(false);
    expect(canAccess('admin', 'members:bulk', 'delete')).toBe(false);
    expect(canAccess('admin', 'members:bulk', 'admin')).toBe(false);
  });

  it('manager: read/write/delete on members:bulk → all deny (read-only never bulk)', () => {
    expect(canAccess('manager', 'members:bulk', 'read')).toBe(false);
    expect(canAccess('manager', 'members:bulk', 'write')).toBe(false);
    expect(canAccess('manager', 'members:bulk', 'delete')).toBe(false);
  });
});

describe('canAccess — exhaustive negative coverage', () => {
  // Defensive: an unknown role string passed by mistake should always
  // be denied. (Cast to bypass the type system in the test.)
  it('denies an unknown role', () => {
    const fakeRole = 'visitor' as Role;
    for (const resource of NON_SELF_RESOURCES) {
      for (const action of ACTIONS) {
        expect(canAccess(fakeRole, resource, action)).toBe(false);
      }
    }
  });

  it('every defined Role appears in ROLES exactly once', () => {
    expect(ROLES).toEqual(['admin', 'manager', 'member']);
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });
});

describe('canAccess — F2 plans + fee_config resources (T056)', () => {
  // F2 adds `plan` and `fee_config` to the Resource union plus the
  // `clone` action. The baseline matrix inherits from F1:
  //   admin   → every action (including clone)
  //   manager → read-only
  //   member  → denied

  it('admin gets every action on plan + fee_config (incl. clone)', () => {
    for (const action of ACTIONS) {
      expect(canAccess('admin', 'plan', action)).toBe(true);
      expect(canAccess('admin', 'fee_config', action)).toBe(true);
    }
  });

  it('manager can READ plan + fee_config', () => {
    expect(canAccess('manager', 'plan', 'read')).toBe(true);
    expect(canAccess('manager', 'fee_config', 'read')).toBe(true);
  });

  it('manager CANNOT mutate plan or fee_config', () => {
    for (const action of ['write', 'delete', 'admin', 'clone'] as const) {
      expect(canAccess('manager', 'plan', action)).toBe(false);
      expect(canAccess('manager', 'fee_config', action)).toBe(false);
    }
  });

  it('member is denied every action on plan + fee_config', () => {
    for (const action of ACTIONS) {
      expect(canAccess('member', 'plan', action)).toBe(false);
      expect(canAccess('member', 'fee_config', action)).toBe(false);
    }
  });

  it('the `clone` action is admin-exclusive', () => {
    expect(canAccess('admin', 'plan', 'clone')).toBe(true);
    expect(canAccess('manager', 'plan', 'clone')).toBe(false);
    expect(canAccess('member', 'plan', 'clone')).toBe(false);
  });
});

describe('isReadOnlyRole', () => {
  it('admin is NOT read-only', () => {
    expect(isReadOnlyRole('admin')).toBe(false);
  });
  it('manager IS read-only', () => {
    expect(isReadOnlyRole('manager')).toBe(true);
  });
  it('member IS read-only', () => {
    expect(isReadOnlyRole('member')).toBe(true);
  });
});
