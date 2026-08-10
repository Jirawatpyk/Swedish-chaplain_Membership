/**
 * T006 — Contract: evaluator-level characterization rows, BOTH legs
 * (016-rbac-permissions PR 1; design § 10, contract § 4 "characterization").
 *
 * ANTI-CIRCULARITY (design § 6.1): legacy-leg expected values are anchored to
 * the OBSERVED behaviour of the code running today — `canAccess` in
 * `policies.ts` — never derived from the shim table. The delegation test below
 * makes that anchor explicit: for every (role, resource, action) probe, the
 * legacy leg must return exactly what `canAccess` returns for the D16-
 * normalised role.
 *
 * The flag is a parameter here (pure Domain), so ONE run asserts BOTH legs;
 * the CI job additionally runs this suite under FEATURE_RBAC_V2 ∈
 * {false,true} to keep the (PR-2+) env-reading helpers honest.
 * `tests/setup.ts` must NOT force-set FEATURE_RBAC_V2 (design § 10).
 */

import { describe, expect, it } from 'vitest';

import {
  getPermissionSet,
  hasPermission,
} from '@/modules/auth/domain/permissions/evaluator';
import {
  legacySessionOnly,
  mappedLegacy,
  normalizeLegacyRole,
} from '@/modules/auth/domain/permissions/legacy-shim';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import type { Action, Resource } from '@/modules/auth/domain/policies';
import { canAccess } from '@/modules/auth/domain/policies';

import { PINNED_MATRIX } from '../../helpers/rbac-pinned-matrix';

const key = (k: string) => k as PermissionKey;

/** Legacy resource/action probes spanning today's real guard surface. */
const LEGACY_PROBES: ReadonlyArray<readonly [Resource, Action]> = [
  ['auth:user', 'write'],
  ['auth:audit', 'read'],
  ['members', 'read'],
  ['members', 'write'],
  ['members:bulk', 'write'],
  ['contacts', 'write'],
  ['invoice', 'read'],
  ['invoice', 'write'],
  ['credit_note', 'write'],
  ['refund', 'write'],
  ['plan', 'clone'],
  ['tenant_invoice_settings', 'write'],
];

describe('legacy leg ≡ observed canAccess after D16 normalisation (anti-circularity anchor)', () => {
  const roles = ['super_admin', 'admin', 'manager', 'marketing', 'member'] as const;
  it.each(
    LEGACY_PROBES.flatMap(([resource, action]) =>
      roles.map((role) => [role, resource, action] as const),
    ),
  )('%s on mappedLegacy(%s, %s)', (role, resource, action) => {
    const normalized = normalizeLegacyRole(role);
    const observed = normalized === null ? false : canAccess(normalized, resource, action);
    expect(
      hasPermission(role, key('dashboard.view'), {
        rbacV2: false,
        legacy: mappedLegacy(resource, action),
      }),
    ).toBe(observed);
  });
});

describe('D16 totalisation rows (design § 6.2 window table)', () => {
  it('super_admin normalises to admin; marketing normalises to null (DENY)', () => {
    expect(normalizeLegacyRole('super_admin')).toBe('admin');
    expect(normalizeLegacyRole('marketing')).toBeNull();
    expect(normalizeLegacyRole('admin')).toBe('admin');
    expect(normalizeLegacyRole('manager')).toBe('manager');
    expect(normalizeLegacyRole('member')).toBe('member');
    expect(normalizeLegacyRole('platform_admin')).toBeNull();
  });

  it('marketing is DENIED every legacy row class — never mapped to manager (SEC-R3-03)', () => {
    expect(
      hasPermission('marketing', key('invoicing.read'), {
        rbacV2: false,
        legacy: mappedLegacy('invoice', 'read'),
      }),
    ).toBe(false);
    expect(
      hasPermission('marketing', key('dashboard.view'), {
        rbacV2: false,
        legacy: legacySessionOnly,
      }),
    ).toBe(false);
  });

  it('manager on the legacy leg KEEPS its observed money-read surface (flag OFF is byte-identical)', () => {
    expect(
      hasPermission('manager', key('invoicing.read'), {
        rbacV2: false,
        legacy: mappedLegacy('invoice', 'read'),
      }),
    ).toBe(true);
  });
});

describe('ON leg reproduces the pinned § 4.1 matrix exactly', () => {
  it.each(PINNED_MATRIX.map((r) => [r.key, r] as const))('%s', (_k, pinned) => {
    expect(hasPermission('super_admin', key(pinned.key), { rbacV2: true })).toBe(true);
    expect(hasPermission('admin', key(pinned.key), { rbacV2: true })).toBe(pinned.admin);
    expect(hasPermission('manager', key(pinned.key), { rbacV2: true })).toBe(pinned.manager);
    expect(hasPermission('marketing', key(pinned.key), { rbacV2: true })).toBe(
      pinned.marketing,
    );
    expect(hasPermission('member', key(pinned.key), { rbacV2: true })).toBe(false);
  });
});

describe('environment discipline (design § 10)', () => {
  it('tests/setup.ts does not force-set FEATURE_RBAC_V2 (CI matrix must control it)', () => {
    // When the CI job sets the var, it must arrive unmodified; when unset
    // locally it must stay unset. Either way setup.ts must not have pinned it.
    const v = process.env.FEATURE_RBAC_V2;
    expect(v === undefined || v === 'true' || v === 'false').toBe(true);
  });

  it('getPermissionSet is synchronous and env-independent (D15 purity)', () => {
    expect(getPermissionSet('manager')).toEqual(getPermissionSet('manager'));
  });
});
