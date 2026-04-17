import { describe, expect, it } from 'vitest';
import {
  canTransition,
  planStateOf,
  type PlanStateSnapshot,
} from '@/modules/plans/domain/plan-state';

describe('PlanState derivation', () => {
  it('is_active=true, deleted_at=null → active', () => {
    const snap: PlanStateSnapshot = { is_active: true, deleted_at: null };
    expect(planStateOf(snap)).toBe('active');
  });

  it('is_active=false, deleted_at=null → inactive', () => {
    const snap: PlanStateSnapshot = { is_active: false, deleted_at: null };
    expect(planStateOf(snap)).toBe('inactive');
  });

  it('deleted_at set → soft_deleted (regardless of is_active)', () => {
    expect(
      planStateOf({ is_active: true, deleted_at: new Date() }),
    ).toBe('soft_deleted');
    expect(
      planStateOf({ is_active: false, deleted_at: new Date() }),
    ).toBe('soft_deleted');
  });
});

describe('canTransition', () => {
  it('active → inactive ok', () => {
    expect(canTransition('active', 'inactive').ok).toBe(true);
  });

  it('inactive → active ok', () => {
    expect(canTransition('inactive', 'active').ok).toBe(true);
  });

  it('inactive → soft_deleted ok when no active members', () => {
    const result = canTransition('inactive', 'soft_deleted', {
      activeMemberCount: 0,
    });
    expect(result.ok).toBe(true);
  });

  it('inactive → soft_deleted ok when ctx.activeMemberCount is omitted (defaults to 0)', () => {
    const result = canTransition('inactive', 'soft_deleted', {});
    expect(result.ok).toBe(true);
  });

  it('inactive → soft_deleted err when active members > 0', () => {
    const result = canTransition('inactive', 'soft_deleted', {
      activeMemberCount: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('active_members_attached');
      if (result.reason === 'active_members_attached') {
        expect(result.count).toBe(3);
      }
    }
  });

  it('soft_deleted → inactive ok (undelete)', () => {
    expect(canTransition('soft_deleted', 'inactive').ok).toBe(true);
  });

  it('no-op (same → same) is always ok', () => {
    expect(canTransition('active', 'active').ok).toBe(true);
    expect(canTransition('soft_deleted', 'soft_deleted').ok).toBe(true);
  });

  it('active → soft_deleted is illegal (must deactivate first)', () => {
    const result = canTransition('active', 'soft_deleted');
    expect(result.ok).toBe(false);
    if (result.ok === false && result.reason === 'illegal_transition') {
      expect(result.from).toBe('active');
      expect(result.to).toBe('soft_deleted');
    }
  });

  it('soft_deleted → active is illegal (must undelete to inactive first)', () => {
    const result = canTransition('soft_deleted', 'active');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('illegal_transition');
    }
  });
});
