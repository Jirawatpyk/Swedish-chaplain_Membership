import { describe, expect, it } from 'vitest';
import type { Role } from '@/modules/auth';
import {
  canAdminMutatePlan,
  canCloneYear,
  canManagerReadPlan,
  canReadPlan,
} from '@/modules/plans/domain/policies';

// NOTE: `canReadFeeConfig` / `canMutateFeeConfig` cases retired in
// R7/R8 consolidation (post-ship R6 C5 sweep, 2026-05-19). Migration
// 0029 dropped `tenant_fee_config`; F4 `tenant_invoice_settings` is
// authoritative now and carries its own RBAC surface in the invoicing
// module.

describe('Plans RBAC policies', () => {
  const roles: Role[] = ['admin', 'manager', 'member'];

  it('canReadPlan — admin + manager yes, member no', () => {
    expect(canReadPlan('admin')).toBe(true);
    expect(canReadPlan('manager')).toBe(true);
    expect(canReadPlan('member')).toBe(false);
  });

  it('canManagerReadPlan alias matches canReadPlan', () => {
    for (const r of roles) {
      expect(canManagerReadPlan(r)).toBe(canReadPlan(r));
    }
  });

  it('canAdminMutatePlan — admin only', () => {
    expect(canAdminMutatePlan('admin')).toBe(true);
    expect(canAdminMutatePlan('manager')).toBe(false);
    expect(canAdminMutatePlan('member')).toBe(false);
  });

  it('canCloneYear — admin only', () => {
    expect(canCloneYear('admin')).toBe(true);
    expect(canCloneYear('manager')).toBe(false);
    expect(canCloneYear('member')).toBe(false);
  });
});
