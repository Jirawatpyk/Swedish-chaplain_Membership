/**
 * T015 — role × endpoint matrix (016-rbac-permissions; single-leg since PR 5).
 *
 * Driven off the (surface → key) register in
 * `tests/helpers/rbac-observed-baseline.ts`. The flag-OFF half — the shim rows
 * and the frozen per-role cells that held the legacy leg byte-identical
 * (SC-002) — was deleted with that leg in PR 5; the SC-002 claim is now
 * history, not an invariant anything can break.
 *
 * Anti-circularity: expectations come from `PINNED_MATRIX` (a hand
 * transcription of design § 4.1) and from frozen literal surface lists —
 * never derived from `ROLE_BUNDLES`, which would be the bundle asserting
 * about itself.
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
import { ALL_PERMISSION_KEYS } from '@/modules/auth/domain/permissions/permission-catalogue';
import type { Role } from '@/modules/auth/domain/role';

const allowed = (role: Role, s: ObservedSurface): boolean => hasPermission(role, s.key);

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
    it(`${name} denies manager`, () => {
      const surface = OBSERVED_BASELINE.find((s) => s.surface === name);
      expect(surface, `surface missing from baseline: ${name}`).toBeDefined();
      expect(allowed('manager', surface!)).toBe(false);
    });
  }

  it('the six mutating users routes are all present and all deny manager', () => {
    const users = OBSERVED_BASELINE.filter(
      (s) => s.surface.includes('/api/auth/users/') || s.surface === 'POST /api/auth/invite',
    );
    expect(users).toHaveLength(6);
    expect(users.every((s) => !allowed('manager', s))).toBe(true);
  });
});

describe('T015 the D4 narrowings hold (INTENTIONAL_NARROWINGS is not stale)', () => {
  // The old form compared the ON leg against the frozen pre-016 cells to prove
  // "narrowed exactly where declared". The cells died with the legacy leg, so
  // the residual invariant is: every DECLARED narrowing still narrows — a
  // plain admin is denied on each listed surface. A narrowing that stops
  // narrowing means either the bundle regressed or the declaration is stale;
  // both deserve a red test.
  it('the role each declaration names is still denied on that surface', () => {
    // The declarations narrow DIFFERENT roles: the D4 entries take surfaces
    // away from plain admin; the design § 10 entries take settings/exports
    // away from manager (admin keeps those). The note text names the role, so
    // read it rather than assuming admin everywhere — the first version did,
    // and flagged three manager-narrowings as "no longer narrowing" while
    // admin was, correctly, still allowed.
    const undeclaredOrStale: string[] = [];
    for (const [surface, note] of Object.entries(INTENTIONAL_NARROWINGS)) {
      const s = OBSERVED_BASELINE.find((x) => x.surface === surface);
      if (!s) {
        undeclaredOrStale.push(`${surface}: not in the baseline register`);
        continue;
      }
      // Which role each entry narrowed lived in the deleted cells, and the
      // note prose does not reliably name it (the data-export entry names
      // neither). The precise residual: a real narrowing denies admin or
      // manager (or both) — a surface where BOTH are allowed cannot be a
      // narrowing of today's model, so its declaration is stale. Marketing is
      // excluded from the disjunction: it is denied nearly everywhere, which
      // would make the check vacuously green.
      void note;
      if (allowed('admin', s) && allowed('manager', s)) {
        undeclaredOrStale.push(
          `${surface}: both admin AND manager are allowed — the declared narrowing no longer narrows`,
        );
      }
    }
    expect(undeclaredOrStale).toEqual([]);
  });
});

describe('T041 per-TARGET-role cells for the six users routes (§ 7.1)', () => {
  // The six mutating users routes gate in TWO steps (T028): the wider
  // `users.member_accounts` before the body/target is read, then
  // `users.manage` once the target row (or requested role) is known to be a
  // staff role. These cells pin the KEY-level outcome that composition
  // produces per (actor, target-class) on both flag legs — the route-level
  // behaviour is exactly `memberTarget AND (staffTarget when staff)`.
  const onKey = (role: Role, key: 'users.manage' | 'users.member_accounts'): boolean =>
    hasPermission(role, key);

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
      const actual = allowed('marketing', s);
      if (actual !== expected) {
        disagreements.push(
          `${s.surface} (${s.key}): design says ${expected}, evaluator says ${actual}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  /**
   * Anti-circularity anchor: the surfaces `marketing` reaches on the ON leg.
   *
   * No money PAGE (`/admin/invoices`, `/admin/plans`, `/admin/renewals`,
   * refunds, credit-notes), no PII egress (`export.zip`, `data-export`,
   * `/admin/directory`), no compliance surface (erasure, audit), and no
   * `/admin/users`.
   *
   * Two entries look surprising and are deliberate, each keyed on something
   * marketing legitimately holds:
   *
   * A THIRD used to sit here — the broadcasts halt-clear route, keyed
   * `broadcasts.write`. 018 split `broadcasts.clear_halt` out of that key
   * and narrowed clearing to the admin tier, so marketing no longer reaches
   * it and the frozen set drops 48 -> 47. See the spec 010 § Requirements
   * amendment for the decision and the operator heads-up.
   * `GET /api/plans/[year]/[planId]/affected-members` is keyed `members.read`;
   * and `GET /api/plans/search` widened to `dashboard.view`
   * (T064) so the ⌘K palette works at all — its plan and member hits are
   * re-gated inside the handler.
   *
   * **This list is reachability, NOT a claim about what the response contains.**
   * The first version of this comment asserted "no money surface appears
   * below" from an eyeball pass, while the list itself admitted BOTH member
   * timeline surfaces — whose payment rows carry `amount_satang` and whose F4
   * audit rows carry `total_satang`. The review caught it; `timelineList` now
   * drops money rows for a viewer without `invoicing.read`
   * (`tests/unit/members/timeline-list-filters.test.ts`). Reachability and
   * payload contents are separate properties and each needs its own test — an
   * eyeball scan of route names cannot see inside a response.
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
    // 108 PR-D — the contact marketing toggle, keyed `contacts.marketing`,
    // which the marketing bundle holds (FR-030). It confers NO other contact
    // edit: every `contacts.write` surface stays below in MUST_DENY territory
    // by omission from this list.
    'POST /api/admin/contacts/[contactId]/marketing',
    'POST /api/admin/events',
    'POST /api/admin/events/[eventId]/archive',
    'POST /api/admin/events/[eventId]/toggle-cultural-event',
    'POST /api/admin/events/[eventId]/toggle-partner-benefit',
    'POST /api/admin/events/import',
    'POST /api/admin/insights/dismiss',
    // 016 T064 — the ⌘K backend. Added DELIBERATELY: it was the one surface
    // whose gate had to widen, because it is the entry point to every staff
    // surface rather than a plans surface, and `plans.read` denied marketing
    // the whole palette. Reaching the endpoint is not seeing plans — plan hits
    // are re-gated on `plans.read` inside the handler.
    'GET /api/plans/search',
  ];

  it('reaches EXACTLY the frozen 48-surface set — nothing more, nothing less', () => {
    const actual = OBSERVED_BASELINE.filter((s) => allowed('marketing', s))
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
    // 108 PR-D (US4 AS6) — `contacts.marketing` must NOT bleed into contact
    // edits: marketing can switch a contact's marketing state, never its
    // name / email / phone.
    'PATCH /api/members/[memberId]/contacts/[contactId]',
    'DELETE /api/members/[memberId]/contacts/[contactId]',
    'POST /api/members/[memberId]/contacts/[contactId]/promote-primary',
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
    expect(allowed('marketing', s!)).toBe(false);
  });
});
