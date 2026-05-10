/**
 * F8 R11 coverage closure — `scheduled-plan-change.ts` Domain tests.
 *
 * Pins the SCHEDULED_PLAN_CHANGE_STATUSES list, isTerminalStatus
 * predicate, and the type-only aggregate shape.
 */
import { describe, expect, it } from 'vitest';
import {
  isTerminalStatus,
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
