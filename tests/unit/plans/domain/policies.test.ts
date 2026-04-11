import { describe, expect, it } from 'vitest';
import type { Role } from '@/modules/auth';
import {
  canAdminMutatePlan,
  canCloneYear,
  canManagerReadPlan,
  canMutateFeeConfig,
  canReadFeeConfig,
  canReadPlan,
} from '@/modules/plans/domain/policies';

describe('Plans + FeeConfig RBAC policies', () => {
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

  it('canReadFeeConfig — admin + manager yes, member no', () => {
    expect(canReadFeeConfig('admin')).toBe(true);
    expect(canReadFeeConfig('manager')).toBe(true);
    expect(canReadFeeConfig('member')).toBe(false);
  });

  it('canMutateFeeConfig — admin only', () => {
    expect(canMutateFeeConfig('admin')).toBe(true);
    expect(canMutateFeeConfig('manager')).toBe(false);
    expect(canMutateFeeConfig('member')).toBe(false);
  });
});
