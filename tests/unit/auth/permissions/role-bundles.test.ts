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

import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';

import {
  PINNED_MATRIX,
  PINNED_SUPER_ADMIN_ONLY,
  WIDGET_KEYS,
} from '../../../helpers/rbac-pinned-matrix';

const k = (s: string) => s as PermissionKey;

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
      expect(ROLE_BUNDLES.admin.has(k(pinned.key)), 'admin').toBe(pinned.admin);
      expect(ROLE_BUNDLES.manager.has(k(pinned.key)), 'manager').toBe(pinned.manager);
      expect(ROLE_BUNDLES.marketing.has(k(pinned.key)), 'marketing').toBe(pinned.marketing);
      // super_admin's BUNDLE holds every non-SA key; SA-only keys come from
      // the evaluator bypass (E1), never from bundle content (FR-003).
      expect(ROLE_BUNDLES.super_admin.has(k(pinned.key)), 'super_admin').toBe(
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
        expect(bundle.has(k(saKey)), `${role} must not hold ${saKey}`).toBe(false);
      }
    }
  });

  it('landing invariant: every staff bundle has dashboard.view + ≥1 widget key', () => {
    for (const role of ['super_admin', 'admin', 'manager', 'marketing'] as const) {
      const bundle = ROLE_BUNDLES[role];
      expect(bundle.has(k('dashboard.view')), `${role} dashboard.view`).toBe(true);
      expect(
        WIDGET_KEYS.some((key) => bundle.has(k(key))),
        `${role} must hold at least one widget permission`,
      ).toBe(true);
    }
  });
});

/**
 * 016 review I5 — bulk/archive PII egress must imply field-level PII access.
 *
 * The members backup CSV (`GET /api/admin/members/export.zip`) and the GDPR
 * member archive both emit contact DATE OF BIRTH, but are gated on
 * `members.bulk` alone — not on `members.pii_sensitive`, which is the key T035
 * put DoB behind on the single-member read. Today that is safe only by
 * coincidence: the two keys happen to have identical holders. PR-4 task T057
 * instructs the implementer to VERIFY rather than re-implement, on the stated
 * assumption that the T035 gating already covers those paths — which is true
 * only while the coincidence holds.
 *
 * This converts the coincidence into an enforced invariant, so a future bundle
 * diff that grants bulk export without field-level PII access fails here
 * instead of silently shipping every contact's date of birth.
 */
describe('016 I5 — PII egress key subsumption', () => {
  it('every bundle holding members.bulk also holds members.pii_sensitive', () => {
    // Non-vacuity: a subset assertion over an empty left-hand side passes for
    // free. If `members.bulk` ever leaves every bundle, this test stops meaning
    // anything and should be revisited rather than silently kept green.
    const holders = ROLES.filter((role) => ROLE_BUNDLES[role].has(k('members.bulk')));
    expect(holders.length, 'no bundle holds members.bulk — the invariant below is vacuous').
      toBeGreaterThan(0);

    const offenders = ROLES.filter(
      (role) =>
        ROLE_BUNDLES[role].has(k('members.bulk')) &&
        !ROLE_BUNDLES[role].has(k('members.pii_sensitive')),
    );
    expect(
      offenders,
      'members.bulk exports contact date-of-birth (members-backup CSV + GDPR ' +
        'archive). A role holding it without members.pii_sensitive would receive ' +
        'PII that the single-member read denies it. Either add the key to that ' +
        'bundle, or gate those two egress paths on it explicitly.',
    ).toEqual([]);
  });
});
