/**
 * T005 — Domain test: evaluator guarantees E1–E6
 * (016-rbac-permissions PR 1; contracts/permission-evaluator.md § 1).
 *
 * The flag is ALWAYS an explicit parameter (purity pin — no env reads in
 * Domain). On the legacy leg the CALLER selects the shim row (per call-site
 * class, contract § 3); with no row the evaluator denies.
 */

import { describe, expect, it } from 'vitest';

import {
  getPermissionSet,
  hasPermission,
} from '@/modules/auth/domain/permissions/evaluator';
import {
  evaluateLegacyRow,
  legacyAdminOrManager,
  legacySessionOnly,
  mappedLegacy,
} from '@/modules/auth/domain/permissions/legacy-shim';
import { ROLES } from '@/modules/auth/domain/role';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

import { PINNED_MATRIX, PINNED_SUPER_ADMIN_ONLY } from '../../../helpers/rbac-pinned-matrix';

const key = (k: string) => k as PermissionKey;

describe('E1 — super_admin bypass is total (flag ON)', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key]))('super_admin allowed on %s', (k) => {
    expect(hasPermission('super_admin', key(k), { rbacV2: true })).toBe(true);
  });
});

describe('E2 — superAdminOnly keys refused for every other role (flag ON)', () => {
  const otherRoles = ['admin', 'manager', 'marketing', 'member'] as const;
  it.each(
    PINNED_SUPER_ADMIN_ONLY.flatMap((k) => otherRoles.map((r) => [r, k] as const)),
  )('%s denied on %s', (role, k) => {
    expect(hasPermission(role, key(k), { rbacV2: true })).toBe(false);
  });

  it('refuses even when a (buggy) bundle contains the SA key', () => {
    const poisoned = {
      admin: new Set<PermissionKey>([key('users.manage')]),
      manager: new Set<PermissionKey>(),
      marketing: new Set<PermissionKey>(),
      member: new Set<PermissionKey>(),
      super_admin: new Set<PermissionKey>(),
    };
    expect(hasPermission('admin', key('users.manage'), { rbacV2: true }, poisoned)).toBe(
      false,
    );
  });
});

describe('E3 — matrix parity for non-SA roles (flag ON)', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key, r] as const))('parity on %s', (_k, pinned) => {
    expect(hasPermission('admin', key(pinned.key), { rbacV2: true })).toBe(pinned.admin);
    expect(hasPermission('manager', key(pinned.key), { rbacV2: true })).toBe(pinned.manager);
    expect(hasPermission('marketing', key(pinned.key), { rbacV2: true })).toBe(
      pinned.marketing,
    );
    expect(hasPermission('member', key(pinned.key), { rbacV2: true })).toBe(false);
  });
});

describe('E4 — legacy leg: D16 totalisation + caller-selected shim row (flag OFF)', () => {
  it('legacySessionOnly: staff roles pass; super_admin evaluates as admin; marketing DENIED', () => {
    const k = key('dashboard.view');
    const row = legacySessionOnly;
    expect(hasPermission('admin', k, { rbacV2: false, legacy: row })).toBe(true);
    expect(hasPermission('manager', k, { rbacV2: false, legacy: row })).toBe(true);
    expect(hasPermission('super_admin', k, { rbacV2: false, legacy: row })).toBe(true);
    expect(hasPermission('marketing', k, { rbacV2: false, legacy: row })).toBe(false);
    expect(hasPermission('member', k, { rbacV2: false, legacy: row })).toBe(false);
  });

  it('mappedLegacy delegates to the observed legacy policy after D16 normalisation', () => {
    const k = key('users.manage');
    const row = mappedLegacy('auth:user', 'write');
    expect(hasPermission('admin', k, { rbacV2: false, legacy: row })).toBe(true);
    expect(hasPermission('super_admin', k, { rbacV2: false, legacy: row })).toBe(true);
    expect(hasPermission('manager', k, { rbacV2: false, legacy: row })).toBe(false);
    expect(hasPermission('marketing', k, { rbacV2: false, legacy: row })).toBe(false);
    expect(hasPermission('member', k, { rbacV2: false, legacy: row })).toBe(false);
  });

  it('no shim row on the legacy leg → deny (safe default)', () => {
    expect(hasPermission('admin', key('members.read'), { rbacV2: false })).toBe(false);
    expect(hasPermission('super_admin', key('members.read'), { rbacV2: false })).toBe(false);
  });

  it('legacyAdminOrManager (the 8 A* inert-check pages) admits the same set as legacySessionOnly', () => {
    const k = key('dashboard.view');
    expect(hasPermission('admin', k, { rbacV2: false, legacy: legacyAdminOrManager })).toBe(true);
    expect(hasPermission('manager', k, { rbacV2: false, legacy: legacyAdminOrManager })).toBe(true);
    expect(hasPermission('super_admin', k, { rbacV2: false, legacy: legacyAdminOrManager })).toBe(
      true,
    );
    expect(hasPermission('marketing', k, { rbacV2: false, legacy: legacyAdminOrManager })).toBe(
      false,
    );
    expect(hasPermission('member', k, { rbacV2: false, legacy: legacyAdminOrManager })).toBe(false);
  });

  it('the two page row classes are extensionally identical (as legacy-shim.ts claims)', () => {
    for (const role of ROLES) {
      expect(
        evaluateLegacyRow(role, legacyAdminOrManager),
        `${role} must agree across the two page row classes`,
      ).toBe(evaluateLegacyRow(role, legacySessionOnly));
    }
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

  it.each(HOSTILE_ROLES.flatMap((r) => [true, false].map((f) => [r, f] as const)))(
    'unknown role %j (rbacV2=%s) → false, no throw',
    (role, rbacV2) => {
      expect(
        hasPermission(role, key('dashboard.view'), {
          rbacV2,
          legacy: legacySessionOnly,
        }),
      ).toBe(false);
      expect(hasPermission(role, key('members.read'), { rbacV2 })).toBe(false);
    },
  );

  it.each(HOSTILE_ROLES)('getPermissionSet(%j) → empty Set, no throw', (role) => {
    const set = getPermissionSet(role);
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('deterministic: the answer does not depend on call order or a previous call', () => {
    // Not a self-comparison — pins the actual expected values so an
    // implementation that memoised wrongly (or read mutable state) fails.
    expect(hasPermission('manager', key('invoicing.read'), { rbacV2: true })).toBe(true);
    expect(hasPermission('manager', key('invoicing.write'), { rbacV2: true })).toBe(false);
    expect(hasPermission('manager', key('invoicing.read'), { rbacV2: true })).toBe(true);
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
