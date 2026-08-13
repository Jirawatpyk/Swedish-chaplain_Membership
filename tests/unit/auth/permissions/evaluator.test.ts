/**
 * T005 — Domain test: evaluator guarantees E1–E6
 * (016-rbac-permissions PR 1; contracts/permission-evaluator.md § 1).
 *
 * Single leg since PR 5 (T068): the flag and the legacy shim are gone, so the
 * evaluator takes just (role, key). E4 died with the leg it characterised.
 */

import { describe, expect, it } from 'vitest';

import {
  getPermissionSet,
  hasPermission,
} from '@/modules/auth/domain/permissions/evaluator';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

import { PINNED_MATRIX, PINNED_SUPER_ADMIN_ONLY } from '../../../helpers/rbac-pinned-matrix';

const key = (k: string) => k as PermissionKey;

describe('E1 — super_admin bypass is total (flag ON)', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key]))('super_admin allowed on %s', (k) => {
    expect(hasPermission('super_admin', key(k))).toBe(true);
  });
});

describe('E2 — superAdminOnly keys refused for every other role (flag ON)', () => {
  const otherRoles = ['admin', 'manager', 'marketing', 'member'] as const;
  it.each(
    PINNED_SUPER_ADMIN_ONLY.flatMap((k) => otherRoles.map((r) => [r, k] as const)),
  )('%s denied on %s', (role, k) => {
    expect(hasPermission(role, key(k))).toBe(false);
  });

  it('refuses even when a (buggy) bundle contains the SA key', () => {
    const poisoned = {
      admin: new Set<PermissionKey>([key('users.manage')]),
      manager: new Set<PermissionKey>(),
      marketing: new Set<PermissionKey>(),
      member: new Set<PermissionKey>(),
      super_admin: new Set<PermissionKey>(),
    };
    expect(hasPermission('admin', key('users.manage'), poisoned)).toBe(
      false,
    );
  });
});

describe('E3 — matrix parity for non-SA roles (flag ON)', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key, r] as const))('parity on %s', (_k, pinned) => {
    expect(hasPermission('admin', key(pinned.key))).toBe(pinned.admin);
    expect(hasPermission('manager', key(pinned.key))).toBe(pinned.manager);
    expect(hasPermission('marketing', key(pinned.key))).toBe(
      pinned.marketing,
    );
    expect(hasPermission('member', key(pinned.key))).toBe(false);
  });
});

describe('E5/E6 — deterministic, total, never throws, never escalates', () => {
  // Includes the Object.prototype member names: a plain object literal would
  // return a Function/prototype for these instead of undefined, so the `??`
  // fallbacks never fire and `.has()` throws (review 016 PR1, rbac-1).
  const HOSTILE_ROLES = [
    'platform_admin',
    '',
    'toString',
    'constructor',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
  ];

  it.each(HOSTILE_ROLES)('unknown role %j → false, no throw', (role) => {
    expect(hasPermission(role, key('dashboard.view'))).toBe(false);
    expect(hasPermission(role, key('members.read'))).toBe(false);
  });

  it.each(HOSTILE_ROLES)('getPermissionSet(%j) → empty Set, no throw', (role) => {
    const set = getPermissionSet(role);
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('deterministic: the answer does not depend on call order or a previous call', () => {
    // Not a self-comparison — pins the actual expected values so an
    // implementation that memoised wrongly (or read mutable state) fails.
    expect(hasPermission('manager', key('invoicing.read'))).toBe(true);
    expect(hasPermission('manager', key('invoicing.write'))).toBe(false);
    expect(hasPermission('manager', key('invoicing.read'))).toBe(true);
  });
});

describe('getPermissionSet (derived, never persisted — D15)', () => {
  it('super_admin set is the FULL catalogue (bypass surfaces in derivation for nav)', () => {
    expect(getPermissionSet('super_admin').size).toBe(40);
    expect(getPermissionSet('super_admin').has(key('users.manage'))).toBe(true);
  });

  it('bundle-backed sizes: admin 34, manager 12, marketing 9, member 0', () => {
    expect(getPermissionSet('admin').size).toBe(34);
    expect(getPermissionSet('manager').size).toBe(12);
    expect(getPermissionSet('marketing').size).toBe(9);
    expect(getPermissionSet('member').size).toBe(0);
  });

  it('unknown role → empty set', () => {
    expect(getPermissionSet('platform_admin').size).toBe(0);
  });
});
