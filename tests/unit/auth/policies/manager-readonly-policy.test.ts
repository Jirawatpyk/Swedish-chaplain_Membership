/**
 * T082 — Manager read-only policy unit tests (spec FR-003 / Q4).
 *
 * Complements `role-policies.test.ts` (T027) with a focused US2
 * contract: demonstrate that `hasPermission()` denies every mutating
 * action a manager could possibly attempt except self-service.
 *
 * The underlying `canAccess()` rules are already exhausted by T027;
 * this suite adds:
 *   - Coverage of the `hasPermission()` public wrapper (T086) so the
 *     application layer has its own failing test before implementation.
 *   - A matrix of the resources the manager WILL encounter during F1
 *     + the future phases (members, invoices, events) so a regression
 *     introduced by a later phase is caught here.
 */
import { describe, expect, it } from 'vitest';
import { hasPermission } from '@/modules/auth/application/has-permission';
import { SELF_RESOURCE } from '@/modules/auth/domain/policies';

const MUTATING_ACTIONS = ['write', 'delete', 'admin'] as const;

// Resources spanning F1 + foreseeable phases — manager must be denied
// on every mutating action for all of them, per spec Q4.
const ALL_F1_RESOURCES = [
  'auth:user',
  'auth:audit',
  'staff:dashboard',
  'members:member',
  'members:contact',
  'invoices:invoice',
  'invoices:payment',
  'events:event',
  'events:registration',
] as const;

describe('hasPermission — manager read-only (US2, FR-003)', () => {
  it('allows manager to READ every resource', () => {
    for (const resource of ALL_F1_RESOURCES) {
      expect(hasPermission('manager', resource, 'read')).toBe(true);
    }
  });

  it.each(MUTATING_ACTIONS)(
    'denies manager %s on every non-self resource',
    (action) => {
      for (const resource of ALL_F1_RESOURCES) {
        expect(hasPermission('manager', resource, action)).toBe(false);
      }
    },
  );

  it('permits manager self-service (change own password)', () => {
    expect(hasPermission('manager', SELF_RESOURCE, 'write')).toBe(true);
    expect(hasPermission('manager', SELF_RESOURCE, 'read')).toBe(true);
  });

  it('denies manager delete/admin even on self', () => {
    expect(hasPermission('manager', SELF_RESOURCE, 'delete')).toBe(false);
    expect(hasPermission('manager', SELF_RESOURCE, 'admin')).toBe(false);
  });
});

describe('hasPermission — admin bypass (regression guard)', () => {
  it('allows admin on every (resource × action) combination', () => {
    for (const resource of ALL_F1_RESOURCES) {
      for (const action of ['read', ...MUTATING_ACTIONS] as const) {
        expect(hasPermission('admin', resource, action)).toBe(true);
      }
    }
  });
});

describe('hasPermission — member cross-portal access (regression guard)', () => {
  it('denies member read on staff resources', () => {
    expect(hasPermission('member', 'staff:dashboard', 'read')).toBe(false);
    expect(hasPermission('member', 'auth:user', 'read')).toBe(false);
    expect(hasPermission('member', 'auth:audit', 'read')).toBe(false);
    // Also: the staff "members management" resource (plural namespace)
    // is forbidden — that is the admin side of member records.
    expect(hasPermission('member', 'members:member', 'read')).toBe(false);
  });

  it('allows member read on their own member: portal resources', () => {
    // The singular `member:` namespace is the member-facing portal
    // (per policies.ts resource id docs).
    expect(hasPermission('member', 'member:portal', 'read')).toBe(true);
    expect(hasPermission('member', 'member:profile', 'read')).toBe(true);
  });

  it('permits member self-service (change own password)', () => {
    expect(hasPermission('member', SELF_RESOURCE, 'write')).toBe(true);
  });
});
