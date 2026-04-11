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

const ACTIONS = ['read', 'write', 'delete', 'admin'] as const;
const NON_SELF_RESOURCES = [
  'auth:user',
  'auth:audit',
  'staff:dashboard',
  'member:portal',
  'invoices:invoice',
  'unknown:thing',
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
