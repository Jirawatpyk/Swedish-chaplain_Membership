/**
 * T015 — role × endpoint matrix (016-rbac-permissions PR 2, US2).
 *
 * The referee for the sweep. Every assertion here is driven off the FROZEN
 * pre-sweep capture in `tests/helpers/rbac-observed-baseline.ts`:
 *
 *   - flag OFF: the shim row attached to each surface must reproduce the
 *     observed per-role outcome exactly (SC-002 — byte-identical behaviour).
 *   - flag ON: the declared key may narrow, never widen, for the three roles
 *     that exist today; every narrowing must be declared.
 *
 * Anti-circularity: the expected cells are literals frozen from an independent
 * re-implementation of the pre-016 policy rules (see the baseline file header).
 * The evaluator under test calls the REAL `canAccess`, so a disagreement
 * between the two implementations fails this suite rather than being absorbed.
 */
import { describe, expect, it } from 'vitest';
import {
  GUARD_EXEMPT_PAGES,
  INTENTIONAL_NARROWINGS,
  OBSERVED_API,
  OBSERVED_BASELINE,
  OBSERVED_PAGES,
  type ObservedSurface,
} from '../../helpers/rbac-observed-baseline';
import { hasPermission } from '@/modules/auth/domain/permissions/evaluator';
import type { LegacyRow } from '@/modules/auth/domain/permissions/legacy-shim';
import { ALL_PERMISSION_KEYS } from '@/modules/auth/domain/permissions/permission-catalogue';
import { ROLES, type Role } from '@/modules/auth/domain/role';

/** The baseline's structural row type is intentionally decoupled; re-attach. */
const asLegacyRow = (surface: ObservedSurface): LegacyRow =>
  surface.row as unknown as LegacyRow;

const offLeg = (role: Role, s: ObservedSurface): boolean =>
  hasPermission(role, s.key, { rbacV2: false, legacy: asLegacyRow(s) });

const onLeg = (role: Role, s: ObservedSurface): boolean =>
  hasPermission(role, s.key, { rbacV2: true });

describe('T015 baseline integrity', () => {
  it('captured 46 guarded pages + 1 exemption = the pinned 47-page inventory', () => {
    expect(OBSERVED_PAGES).toHaveLength(46);
    expect(GUARD_EXEMPT_PAGES).toHaveLength(1);
  });

  it('captured every staff API handler', () => {
    expect(OBSERVED_API.length).toBeGreaterThanOrEqual(131);
  });

  it('declares no surface twice', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of OBSERVED_BASELINE) {
      if (seen.has(s.surface)) dupes.push(s.surface);
      seen.add(s.surface);
    }
    expect(dupes).toEqual([]);
  });

  it('declares only catalogue keys', () => {
    const unknown = OBSERVED_BASELINE.filter((s) => !ALL_PERMISSION_KEYS.has(s.key));
    expect(unknown.map((s) => `${s.surface} -> ${s.key}`)).toEqual([]);
  });

  it('records a non-empty observed guard for every surface', () => {
    expect(OBSERVED_BASELINE.filter((s) => s.guard.trim() === '')).toEqual([]);
  });
});

describe('T015 page-class membership matches contracts § 1.1', () => {
  // The 17 pure session-only pages are the EXACT `legacySessionOnly` membership
  // (contracts § 1.1 Class A). Pinned as a literal set: a page silently joining
  // or leaving the ungated class is the regression this catches.
  const CLASS_A = [
    '/admin',
    '/admin/account',
    '/admin/audit',
    '/admin/broadcasts',
    '/admin/broadcasts/[id]',
    '/admin/credit-notes/[creditNoteId]',
    '/admin/directory',
    '/admin/invoices',
    '/admin/invoices/[invoiceId]',
    '/admin/members',
    '/admin/members/[memberId]',
    '/admin/members/[memberId]/timeline',
    '/admin/plans',
    '/admin/plans/[year]/[planId]',
    '/admin/settings',
    '/admin/settings/invoicing',
    '/admin/users',
  ];

  const CLASS_A_STAR = [
    '/admin/credit-notes',
    '/admin/events',
    '/admin/events/[eventId]',
    '/admin/members/[memberId]/benefits',
    '/admin/renewals',
    '/admin/renewals/[cycleId]',
    '/admin/renewals/tasks',
    '/admin/settings/renewals/schedules',
  ];

  it('legacySessionOnly ≡ the 17 Class-A pages', () => {
    const actual = OBSERVED_PAGES.filter((p) => p.row.kind === 'legacySessionOnly')
      .map((p) => p.surface)
      .sort();
    expect(actual).toEqual([...CLASS_A].sort());
  });

  it('legacyAdminOrManager ≡ the 8 Class-A* inert-check pages', () => {
    const actual = OBSERVED_PAGES.filter((p) => p.row.kind === 'legacyAdminOrManager')
      .map((p) => p.surface)
      .sort();
    expect(actual).toEqual([...CLASS_A_STAR].sort());
  });

  it('the remaining 21 pages are the admin-only class', () => {
    expect(OBSERVED_PAGES.filter((p) => p.row.kind === 'legacyAdminOnly')).toHaveLength(21);
  });
});

describe('T015 flag-OFF leg reproduces observed behaviour (SC-002)', () => {
  for (const surface of OBSERVED_BASELINE) {
    it(`${surface.surface} — all five roles`, () => {
      const actual: Record<string, string> = {};
      for (const role of ROLES) {
        actual[role] = offLeg(role, surface) ? 'allow' : 'deny';
      }
      expect(actual).toEqual({ ...surface.cells });
    });
  }
});

describe('T015 anti-circularity anchors (manager stays denied)', () => {
  const MUST_DENY_MANAGER = [
    'POST /api/auth/invite',
    'POST /api/auth/users/[id]/role',
    'POST /api/auth/users/[id]/disable',
    'POST /api/auth/users/[id]/enable',
    'POST /api/auth/users/[id]/reissue-invite',
    'POST /api/auth/users/[id]/revoke-invite',
    'POST /api/members/[memberId]/erase',
    'POST /api/admin/events/erasure',
    'POST /api/admin/events/[eventId]/registrations/[registrationId]/erase',
    '/admin/compliance/erasure-log',
    'PATCH /api/tenant-invoice-settings',
    'POST /api/tenant-invoice-settings/logo',
  ];

  for (const name of MUST_DENY_MANAGER) {
    it(`${name} denies manager on BOTH legs`, () => {
      const surface = OBSERVED_BASELINE.find((s) => s.surface === name);
      expect(surface, `surface missing from baseline: ${name}`).toBeDefined();
      expect(surface!.cells.manager).toBe('deny');
      expect(offLeg('manager', surface!)).toBe(false);
      expect(onLeg('manager', surface!)).toBe(false);
    });
  }

  it('the six mutating users routes are all present and all deny manager', () => {
    const users = OBSERVED_BASELINE.filter(
      (s) => s.surface.includes('/api/auth/users/') || s.surface === 'POST /api/auth/invite',
    );
    expect(users).toHaveLength(6);
    expect(users.every((s) => s.cells.manager === 'deny')).toBe(true);
  });
});

describe('T015 flag-ON leg never widens for a role that exists today', () => {
  // super_admin and marketing gain access BY DESIGN (the whole feature), so the
  // no-widening invariant is scoped to the three pre-016 roles.
  const PRE_016_ROLES: readonly Role[] = ['admin', 'manager', 'member'];

  it('no surface grants admin, manager or member more than it does today', () => {
    const widenings: string[] = [];
    for (const s of OBSERVED_BASELINE) {
      for (const role of PRE_016_ROLES) {
        if (s.cells[role] === 'deny' && onLeg(role, s)) {
          widenings.push(`${s.surface} :: ${role}`);
        }
      }
    }
    expect(widenings).toEqual([]);
  });

  it('every narrowing is declared in INTENTIONAL_NARROWINGS', () => {
    const narrowed = new Set<string>();
    for (const s of OBSERVED_BASELINE) {
      for (const role of PRE_016_ROLES) {
        if (s.cells[role] === 'allow' && !onLeg(role, s)) narrowed.add(s.surface);
      }
    }
    expect([...narrowed].sort()).toEqual(Object.keys(INTENTIONAL_NARROWINGS).sort());
  });
});
