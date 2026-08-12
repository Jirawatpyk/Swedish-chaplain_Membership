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
import { PINNED_MATRIX } from '../../helpers/rbac-pinned-matrix';
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

describe('T041 per-TARGET-role cells for the six users routes (§ 7.1)', () => {
  // The six mutating users routes gate in TWO steps (T028): the wider
  // `users.member_accounts` before the body/target is read, then
  // `users.manage` once the target row (or requested role) is known to be a
  // staff role. These cells pin the KEY-level outcome that composition
  // produces per (actor, target-class) on both flag legs — the route-level
  // behaviour is exactly `memberTarget AND (staffTarget when staff)`.
  const USERS_ROUTES_OFF_ROW: LegacyRow = {
    kind: 'mappedLegacy',
    resource: 'auth:user',
    action: 'write',
  };

  const onKey = (role: Role, key: 'users.manage' | 'users.member_accounts'): boolean =>
    hasPermission(role, key, { rbacV2: true });
  const off = (role: Role): boolean =>
    hasPermission(role, 'users.manage', { rbacV2: false, legacy: USERS_ROUTES_OFF_ROW });

  it('ON leg, STAFF-role target (users.manage) — super_admin alone (D4)', () => {
    expect(onKey('super_admin', 'users.manage')).toBe(true);
    expect(onKey('admin', 'users.manage')).toBe(false);
    expect(onKey('manager', 'users.manage')).toBe(false);
    expect(onKey('marketing', 'users.manage')).toBe(false);
    expect(onKey('member', 'users.manage')).toBe(false);
  });

  it('ON leg, MEMBER-account target (users.member_accounts) — super_admin + admin', () => {
    expect(onKey('super_admin', 'users.member_accounts')).toBe(true);
    expect(onKey('admin', 'users.member_accounts')).toBe(true);
    expect(onKey('manager', 'users.member_accounts')).toBe(false);
    expect(onKey('marketing', 'users.member_accounts')).toBe(false);
    expect(onKey('member', 'users.member_accounts')).toBe(false);
  });

  it('OFF leg, BOTH targets share the pre-sweep row — admin (+ super_admin via D16) only', () => {
    expect(off('super_admin')).toBe(true);
    expect(off('admin')).toBe(true);
    expect(off('manager')).toBe(false);
    expect(off('marketing')).toBe(false);
    expect(off('member')).toBe(false);
  });
});

/**
 * T053 (016 PR 4, US3) — the MARKETING surface matrix.
 *
 * PR 4 makes `marketing` assignable, so its reachable set stops being theory.
 * Everything below asserts against sources INDEPENDENT of `ROLE_BUNDLES`:
 *
 *   - `PINNED_MATRIX` is a hand transcription of design § 4.1, so it can
 *     disagree with the implementation. Deriving expectations from
 *     `ROLE_BUNDLES` instead would be a tautology — the bundle would be
 *     asserting about itself.
 *   - the 47-surface list is FROZEN LITERAL text, reviewed by eye once. A
 *     computed list would re-derive the very thing under test and pass no
 *     matter what the bundle said.
 *
 * MUTATION PROOF (recorded at authoring, re-run it if you touch this file):
 * adding `'invoicing.read'` to `MARKETING_KEYS` must turn these RED. A version
 * of this suite that survives that mutation pins nothing.
 */
describe('T053 marketing reachable surfaces (US3)', () => {
  it('every surface agrees with the pinned § 4.1 design table', () => {
    const disagreements: string[] = [];
    for (const s of OBSERVED_BASELINE) {
      const pinned = PINNED_MATRIX.find((r) => r.key === s.key);
      if (!pinned) {
        disagreements.push(`${s.surface}: key '${s.key}' missing from PINNED_MATRIX`);
        continue;
      }
      // superAdminOnly keys are refused by the evaluator for every other role
      // (contract E2), so the design's per-role column is not consulted.
      const expected = pinned.superAdminOnly === true ? false : pinned.marketing;
      const actual = onLeg('marketing', s);
      if (actual !== expected) {
        disagreements.push(
          `${s.surface} (${s.key}): design says ${expected}, evaluator says ${actual}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  /**
   * Anti-circularity anchor. Reviewed by eye at authoring: no money surface
   * (`/admin/invoices`, `/admin/plans`, `/admin/renewals`, refunds,
   * credit-notes), no PII egress (`export.zip`, `data-export`,
   * `/admin/directory`), no compliance surface (erasure, audit), and no
   * `/admin/users` appears below. Two entries look surprising and are
   * deliberate, both keyed on something marketing legitimately holds:
   * `GET /api/plans/[year]/[planId]/affected-members` is keyed `members.read`,
   * and `POST /api/admin/members/[id]/broadcasts-halt-clear` is keyed
   * `broadcasts.write`. `/admin/settings` is reachable but every child denies —
   * T064/D-8 filters that index so it is not a dead end.
   */
  const MARKETING_REACHABLE: readonly string[] = [
    '/admin',
    '/admin/account',
    '/admin/broadcasts',
    '/admin/broadcasts/[id]',
    '/admin/broadcasts/new',
    '/admin/broadcasts/templates',
    '/admin/broadcasts/templates/[id]/edit',
    '/admin/broadcasts/templates/new',
    '/admin/events',
    '/admin/events/[eventId]',
    '/admin/events/import',
    '/admin/events/import/history',
    '/admin/members',
    '/admin/members/[memberId]',
    '/admin/members/[memberId]/benefits',
    '/admin/members/[memberId]/timeline',
    '/admin/settings',
    'DELETE /api/admin/broadcasts/templates/[id]',
    'GET /api/admin/broadcasts',
    'GET /api/admin/broadcasts/sla-stats',
    'GET /api/admin/broadcasts/templates',
    'GET /api/admin/events',
    'GET /api/admin/events/[eventId]',
    'GET /api/admin/events/import/[recordId]/error-csv',
    'GET /api/admin/events/import/history',
    'GET /api/admin/members/search',
    'GET /api/geo/postal/[code]',
    'GET /api/members',
    'GET /api/members/[memberId]',
    'GET /api/members/[memberId]/timeline',
    'GET /api/members/ids',
    'GET /api/plans/[year]/[planId]/affected-members',
    'PATCH /api/admin/broadcasts/templates/[id]',
    'POST /api/admin/broadcasts/[id]/accept-partial',
    'POST /api/admin/broadcasts/[id]/approve',
    'POST /api/admin/broadcasts/[id]/cancel',
    'POST /api/admin/broadcasts/[id]/reject',
    'POST /api/admin/broadcasts/[id]/retry',
    'POST /api/admin/broadcasts/proxy-submit',
    'POST /api/admin/broadcasts/templates',
    'POST /api/admin/events',
    'POST /api/admin/events/[eventId]/archive',
    'POST /api/admin/events/[eventId]/toggle-cultural-event',
    'POST /api/admin/events/[eventId]/toggle-partner-benefit',
    'POST /api/admin/events/import',
    'POST /api/admin/insights/dismiss',
    'POST /api/admin/members/[id]/broadcasts-halt-clear',
    // 016 T064 — the ⌘K backend. Added DELIBERATELY: it was the one surface
    // whose gate had to widen, because it is the entry point to every staff
    // surface rather than a plans surface, and `plans.read` denied marketing
    // the whole palette. Reaching the endpoint is not seeing plans — plan hits
    // are re-gated on `plans.read` inside the handler.
    'GET /api/plans/search',
  ];

  it('reaches EXACTLY the frozen 48-surface set — nothing more, nothing less', () => {
    const actual = OBSERVED_BASELINE.filter((s) => onLeg('marketing', s))
      .map((s) => s.surface)
      .sort();
    expect(actual).toEqual([...MARKETING_REACHABLE].sort());
  });

  /**
   * Named denials. The frozen list above already implies these, but naming the
   * money/PII/compliance surfaces explicitly means a future edit that widens
   * one of them fails with a message that says WHAT was widened, instead of a
   * 47-line array diff nobody reads.
   */
  const MUST_DENY_MARKETING: readonly string[] = [
    // money
    '/admin/invoices',
    '/admin/credit-notes',
    '/admin/plans',
    '/admin/renewals',
    'POST /api/invoices',
    'POST /api/refunds/initiate',
    'POST /api/credit-notes',
    // PII egress
    'GET /api/admin/members/export.zip',
    'POST /api/admin/members/[id]/data-export',
    '/admin/directory',
    'POST /api/admin/directory/exports',
    // compliance / administration
    '/admin/audit',
    '/admin/users',
    '/admin/compliance/erasure-log',
    '/admin/settings/invoicing',
    'POST /api/members/[memberId]/erase',
    'POST /api/admin/events/[eventId]/registrations/[registrationId]/relink',
  ];

  it.each(MUST_DENY_MARKETING)('denies marketing on %s', (surface) => {
    const s = OBSERVED_BASELINE.find((x) => x.surface === surface);
    expect(s, `${surface} is not in the frozen baseline — did it get renamed?`).toBeDefined();
    expect(onLeg('marketing', s!)).toBe(false);
  });
});
