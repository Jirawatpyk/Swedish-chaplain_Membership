/**
 * T035 — RBAC matrix for F3 resources (members, members:bulk, members:own,
 * contacts, contacts:own) across admin / manager / member.
 *
 * Principle II: failing tests authored before use cases referencing these
 * rules land. This file exercises the Domain policy directly — no
 * Application / Infrastructure imports required.
 */
import { describe, expect, it } from 'vitest';
import { canAccess } from '@/modules/auth/domain/policies';

// --- admin ---------------------------------------------------------------

describe('F3 RBAC — admin', () => {
  it.each(['read', 'write', 'delete'] as const)(
    'admin can %s members',
    (action) => {
      expect(canAccess('admin', 'members', action)).toBe(true);
    },
  );

  it('admin can run bulk actions', () => {
    expect(canAccess('admin', 'members:bulk', 'write')).toBe(true);
  });

  it.each(['read', 'write', 'delete'] as const)(
    'admin can %s contacts',
    (action) => {
      expect(canAccess('admin', 'contacts', action)).toBe(true);
    },
  );
});

// --- manager -------------------------------------------------------------

describe('F3 RBAC — manager', () => {
  it('manager can read members', () => {
    expect(canAccess('manager', 'members', 'read')).toBe(true);
  });

  it.each(['write', 'delete'] as const)(
    'manager cannot %s members',
    (action) => {
      expect(canAccess('manager', 'members', action)).toBe(false);
    },
  );

  it('manager cannot run bulk actions', () => {
    expect(canAccess('manager', 'members:bulk', 'write')).toBe(false);
  });

  it('manager can read contacts', () => {
    expect(canAccess('manager', 'contacts', 'read')).toBe(true);
  });

  it.each(['write', 'delete'] as const)(
    'manager cannot %s contacts',
    (action) => {
      expect(canAccess('manager', 'contacts', action)).toBe(false);
    },
  );
});

// --- member --------------------------------------------------------------

describe('F3 RBAC — member (self-service only)', () => {
  it('member cannot read the full directory', () => {
    expect(canAccess('member', 'members', 'read')).toBe(false);
  });

  it('member cannot write into the full directory', () => {
    expect(canAccess('member', 'members', 'write')).toBe(false);
  });

  it('member can read + write their own profile', () => {
    expect(canAccess('member', 'members:own', 'read')).toBe(true);
    expect(canAccess('member', 'members:own', 'write')).toBe(true);
  });

  it('member can read + write their own contact', () => {
    expect(canAccess('member', 'contacts:own', 'read')).toBe(true);
    expect(canAccess('member', 'contacts:own', 'write')).toBe(true);
  });

  it('member cannot run bulk actions', () => {
    expect(canAccess('member', 'members:bulk', 'write')).toBe(false);
  });

  it('member cannot read arbitrary contacts', () => {
    expect(canAccess('member', 'contacts', 'read')).toBe(false);
  });

  it('member cannot delete own profile (soft-delete is admin-only)', () => {
    expect(canAccess('member', 'members:own', 'delete')).toBe(false);
    expect(canAccess('member', 'contacts:own', 'delete')).toBe(false);
  });
});
