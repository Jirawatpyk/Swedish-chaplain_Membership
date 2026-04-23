/**
 * T034 unit test — F5 RBAC policy matrix.
 *
 * Verifies every row of spec `specs/009-online-payment/security.md § 4`
 * RBAC matrix resolves correctly via the `isAllowed()` helper. Any
 * spec/table drift fails here — mirrors F4 audit-coverage test pattern.
 */
import { describe, expect, it } from 'vitest';
import {
  isAllowed,
  type F5Role,
} from '@/modules/payments/domain/rbac-policy';

describe('F5 RBAC policy (T034)', () => {
  describe('payments', () => {
    it('member can initiate, cancel-own, read-own', () => {
      expect(isAllowed('member', 'payments', 'initiate')).toBe(true);
      expect(isAllowed('member', 'payments', 'cancel-own')).toBe(true);
      expect(isAllowed('member', 'payments', 'read-own')).toBe(true);
    });
    it('admin + manager can read-timeline + read-list (admin-UI filter)', () => {
      for (const role of ['admin', 'manager'] as F5Role[]) {
        expect(isAllowed(role, 'payments', 'read-timeline')).toBe(true);
        expect(isAllowed(role, 'payments', 'read-list')).toBe(true);
      }
    });
    it('admin cannot initiate (admin impersonation out of scope per spec § 4)', () => {
      expect(isAllowed('admin', 'payments', 'initiate')).toBe(false);
      expect(isAllowed('manager', 'payments', 'initiate')).toBe(false);
    });
    it('manager cannot cancel or read-own', () => {
      expect(isAllowed('manager', 'payments', 'cancel-own')).toBe(false);
      expect(isAllowed('manager', 'payments', 'read-own')).toBe(false);
    });
  });

  describe('refunds', () => {
    it('admin ONLY can issue', () => {
      expect(isAllowed('admin', 'refunds', 'issue')).toBe(true);
      expect(isAllowed('manager', 'refunds', 'issue')).toBe(false);
      expect(isAllowed('member', 'refunds', 'issue')).toBe(false);
    });
    it('admin + manager can read-timeline + read-list', () => {
      for (const role of ['admin', 'manager'] as F5Role[]) {
        expect(isAllowed(role, 'refunds', 'read-timeline')).toBe(true);
        expect(isAllowed(role, 'refunds', 'read-list')).toBe(true);
      }
    });
    it('member cannot touch any refund action', () => {
      const actions = [
        'initiate',
        'cancel-own',
        'issue',
        'read-timeline',
        'read-list',
        'read-own',
      ] as const;
      for (const action of actions) {
        expect(isAllowed('member', 'refunds', action)).toBe(false);
      }
    });
  });

  describe('payment-settings', () => {
    it('admin ONLY can update', () => {
      expect(isAllowed('admin', 'payment-settings', 'update')).toBe(true);
      expect(isAllowed('manager', 'payment-settings', 'update')).toBe(false);
      expect(isAllowed('member', 'payment-settings', 'update')).toBe(false);
    });
    it('admin can read-list (admin detail view)', () => {
      expect(isAllowed('admin', 'payment-settings', 'read-list')).toBe(true);
    });
  });

  describe('online-payment-toggle', () => {
    it('admin ONLY can toggle FEATURE_F5_ONLINE_PAYMENT per tenant', () => {
      expect(
        isAllowed('admin', 'online-payment-toggle', 'toggle-online'),
      ).toBe(true);
      expect(
        isAllowed('manager', 'online-payment-toggle', 'toggle-online'),
      ).toBe(false);
      expect(
        isAllowed('member', 'online-payment-toggle', 'toggle-online'),
      ).toBe(false);
    });
  });

  describe('fail-closed on unknown inputs', () => {
    it('returns false for an action the policy does not list for the resource', () => {
      // payments.update is NOT permitted for any role
      for (const role of ['admin', 'manager', 'member'] as F5Role[]) {
        expect(isAllowed(role, 'payments', 'update')).toBe(false);
      }
    });
  });
});
