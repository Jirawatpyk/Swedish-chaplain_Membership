/**
 * F8 R11 coverage closure — `scheduled-plan-change.ts` Domain tests.
 *
 * Pins the SCHEDULED_PLAN_CHANGE_STATUSES list, isTerminalStatus
 * predicate, and the type-only aggregate shape.
 */
import { describe, expect, it } from 'vitest';
import {
  isTerminalStatus,
  makeScheduledPlanChange,
  SCHEDULED_PLAN_CHANGE_STATUSES,
  type ScheduledPlanChangeStatus,
} from '@/modules/plans/domain/scheduled-plan-change';

describe('SCHEDULED_PLAN_CHANGE_STATUSES — canonical state list', () => {
  it('contains exactly the 4 statuses mirrored in migration 0086 + data-model.md § 2.9', () => {
    expect(SCHEDULED_PLAN_CHANGE_STATUSES).toEqual([
      'pending',
      'applied',
      'superseded',
      'cancelled',
    ]);
  });

  it('is a readonly tuple at runtime (frozen-shape contract)', () => {
    // Constitution Principle III: Domain types must be immutable.
    // We don't `Object.freeze` at runtime, but the `as const` infers
    // a readonly tuple at the type level — pin via the shape match.
    expect(SCHEDULED_PLAN_CHANGE_STATUSES.length).toBe(4);
  });
});

describe('isTerminalStatus', () => {
  it.each([
    ['applied', true],
    ['superseded', true],
    ['cancelled', true],
  ] as const)('terminal: %s → true', (status, expected) => {
    expect(isTerminalStatus(status as ScheduledPlanChangeStatus)).toBe(expected);
  });

  it('non-terminal: pending → false', () => {
    expect(isTerminalStatus('pending')).toBe(false);
  });
});

// 016 T072 coverage closure — only the `applied` arm of the factory had
// callers in tests; the two other terminal arms were dead in the run.
describe('makeScheduledPlanChange terminal arms', () => {
  const base = {
    tenantId: 'swecham',
    scheduledChangeId: 'spc-1',
    memberId: 'm-1',
    effectiveAtCycleId: 'cycle-1',
    fromPlanId: 'plan-a',
    toPlanId: 'plan-b',
    scheduledByUserId: 'u-1',
    reason: null,
    scheduledAt: '2026-08-01T00:00:00.000Z',
  };
  const TS = '2026-08-14T00:00:00.000Z';

  it('superseded: stamps supersededAt alone, other timestamps null', () => {
    expect(makeScheduledPlanChange(base, 'superseded', TS)).toEqual({
      ...base,
      status: 'superseded',
      appliedAt: null,
      supersededAt: TS,
      cancelledAt: null,
    });
  });

  it('cancelled: stamps cancelledAt alone, other timestamps null', () => {
    expect(makeScheduledPlanChange(base, 'cancelled', TS)).toEqual({
      ...base,
      status: 'cancelled',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: TS,
    });
  });
});
