/**
 * T004 + T007 targets — Domain test: role bundles + Role widening
 * (016-rbac-permissions PR 1).
 *
 * Table-driven parity against the pinned § 4.1 matrix plus the bundle
 * invariants (spec FR-002/FR-003, design § 8 landing invariant) and the
 * ROLES ×5 widening (spec FR-001).
 */

import { describe, expect, it } from 'vitest';

import { PORTAL_FOR_ROLE, ROLES, STAFF_ROLES } from '@/modules/auth/domain/role';
import { ROLE_BUNDLES } from '@/modules/auth/domain/permissions/role-bundles';

import {
  PINNED_MATRIX,
  PINNED_SUPER_ADMIN_ONLY,
  WIDGET_KEYS,
} from '../../../helpers/rbac-pinned-matrix';

describe('Role widening (FR-001)', () => {
  it('ROLES is exactly the five system roles', () => {
    expect([...ROLES].sort()).toEqual(
      ['admin', 'manager', 'marketing', 'member', 'super_admin'].sort(),
    );
  });

  it('super_admin and marketing are staff roles mapping to the staff portal', () => {
    expect(STAFF_ROLES).toContain('super_admin');
    expect(STAFF_ROLES).toContain('marketing');
    expect(PORTAL_FOR_ROLE.super_admin).toBe('staff');
    expect(PORTAL_FOR_ROLE.marketing).toBe('staff');
    expect(PORTAL_FOR_ROLE.member).toBe('member');
  });
});

describe('ROLE_BUNDLES (§ 4.1 pinned parity)', () => {
  it('defines a bundle for every role and no extras', () => {
    expect(Object.keys(ROLE_BUNDLES).sort()).toEqual([...ROLES].sort());
  });

  it.each(PINNED_MATRIX.map((r) => [r.key, r] as const))(
    'matrix parity for %s',
    (_key, pinned) => {
      expect(ROLE_BUNDLES.admin.has(pinned.key), 'admin').toBe(pinned.admin);
      expect(ROLE_BUNDLES.manager.has(pinned.key), 'manager').toBe(pinned.manager);
      expect(ROLE_BUNDLES.marketing.has(pinned.key), 'marketing').toBe(pinned.marketing);
      // super_admin's BUNDLE holds every non-SA key; SA-only keys come from
      // the evaluator bypass (E1), never from bundle content (FR-003).
      expect(ROLE_BUNDLES.super_admin.has(pinned.key), 'super_admin').toBe(
        pinned.superAdminOnly !== true,
      );
    },
  );

  it('member bundle is empty (member-portal authz untouched by this feature)', () => {
    expect(ROLE_BUNDLES.member.size).toBe(0);
  });

  it('no bundle contains a superAdminOnly key (FR-003)', () => {
    for (const [role, bundle] of Object.entries(ROLE_BUNDLES)) {
      for (const saKey of PINNED_SUPER_ADMIN_ONLY) {
        expect(bundle.has(saKey), `${role} must not hold ${saKey}`).toBe(false);
      }
    }
  });

  it('landing invariant: every staff bundle has dashboard.view + ≥1 widget key', () => {
    for (const role of ['super_admin', 'admin', 'manager', 'marketing'] as const) {
      const bundle = ROLE_BUNDLES[role];
      expect(bundle.has('dashboard.view'), `${role} dashboard.view`).toBe(true);
      expect(
        WIDGET_KEYS.some((k) => bundle.has(k)),
        `${role} must hold at least one widget permission`,
      ).toBe(true);
    }
  });
});
