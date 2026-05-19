/**
 * R2 Batch 3a (R2-C4) — unit tests for `assertValidScheduledPlanChange`.
 *
 * Pinned contract:
 *   - Positive cases — 4 status values × correct timestamp tuple
 *   - Negative cases — every illegal status↔timestamp combination
 *     throws `InvalidScheduledPlanChangeError`
 *
 * The assert is called from `drizzle-scheduled-plan-change-repo.rowToDomain`
 * to catch DB CHECK drift (migration 0095 enforces this at the DB
 * layer; the assert is defence-in-depth).
 */
import { describe, expect, it } from 'vitest';
import {
  assertValidScheduledPlanChange,
  InvalidScheduledPlanChangeError,
  type ScheduledPlanChange,
} from '@/modules/plans/domain/scheduled-plan-change';

function baseRow(): ScheduledPlanChange {
  return {
    tenantId: 'swecham',
    scheduledChangeId: 'sched-001',
    memberId: '11111111-1111-1111-1111-111111111111',
    effectiveAtCycleId: '22222222-2222-2222-2222-222222222222',
    fromPlanId: 'corporate-standard',
    toPlanId: 'corporate-premium',
    scheduledByUserId: 'admin',
    reason: null,
    status: 'pending',
    scheduledAt: '2026-05-01T00:00:00Z',
    appliedAt: null,
    supersededAt: null,
    cancelledAt: null,
  };
}

describe('assertValidScheduledPlanChange — positive (every status with correct timestamps)', () => {
  it('pending: all three terminal timestamps null', () => {
    expect(() => assertValidScheduledPlanChange(baseRow())).not.toThrow();
  });

  it('applied: appliedAt set, others null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'applied',
        appliedAt: '2026-05-19T10:00:00Z',
      }),
    ).not.toThrow();
  });

  it('superseded: supersededAt set, others null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'superseded',
        supersededAt: '2026-05-19T10:00:00Z',
      }),
    ).not.toThrow();
  });

  it('cancelled: cancelledAt set, others null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'cancelled',
        cancelledAt: '2026-05-19T10:00:00Z',
      }),
    ).not.toThrow();
  });
});

describe('assertValidScheduledPlanChange — negative (illegal status↔timestamp combos)', () => {
  it('throws when status=pending but appliedAt is set', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'pending',
        appliedAt: '2026-05-19T00:00:00Z',
      }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  it('throws when status=applied but appliedAt is null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'applied',
        appliedAt: null,
      }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  it('throws when status=applied and a non-applied terminal timestamp is also set', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'applied',
        appliedAt: '2026-05-19T00:00:00Z',
        supersededAt: '2026-05-19T01:00:00Z',
      }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  it('throws when status=superseded but supersededAt is null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'superseded',
        supersededAt: null,
      }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  it('throws when status=cancelled but cancelledAt is null', () => {
    expect(() =>
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'cancelled',
        cancelledAt: null,
      }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  // R3 Batch 4d (R3-S11) — extra illegal-combo grid coverage.
  it.each([
    // pending: every terminal timestamp MUST be null
    [
      'pending+supersededAt-set',
      { status: 'pending' as const, supersededAt: '2026-05-19T00:00:00Z' },
    ],
    [
      'pending+cancelledAt-set',
      { status: 'pending' as const, cancelledAt: '2026-05-19T00:00:00Z' },
    ],
    // applied: only appliedAt should be set
    [
      'applied+cancelledAt-set',
      {
        status: 'applied' as const,
        appliedAt: '2026-05-19T00:00:00Z',
        cancelledAt: '2026-05-19T00:00:00Z',
      },
    ],
    // superseded: only supersededAt should be set
    [
      'superseded+appliedAt-set',
      {
        status: 'superseded' as const,
        supersededAt: '2026-05-19T00:00:00Z',
        appliedAt: '2026-05-19T00:00:00Z',
      },
    ],
    [
      'superseded+cancelledAt-set',
      {
        status: 'superseded' as const,
        supersededAt: '2026-05-19T00:00:00Z',
        cancelledAt: '2026-05-19T00:00:00Z',
      },
    ],
    // cancelled: only cancelledAt should be set
    [
      'cancelled+appliedAt-set',
      {
        status: 'cancelled' as const,
        cancelledAt: '2026-05-19T00:00:00Z',
        appliedAt: '2026-05-19T00:00:00Z',
      },
    ],
    [
      'cancelled+supersededAt-set',
      {
        status: 'cancelled' as const,
        cancelledAt: '2026-05-19T00:00:00Z',
        supersededAt: '2026-05-19T00:00:00Z',
      },
    ],
  ])('throws on illegal combo: %s', (_label, overrides) => {
    expect(() =>
      assertValidScheduledPlanChange({ ...baseRow(), ...overrides }),
    ).toThrow(InvalidScheduledPlanChangeError);
  });

  it('error preserves Domain detail (status + scheduledChangeId in message)', () => {
    try {
      assertValidScheduledPlanChange({
        ...baseRow(),
        status: 'pending',
        cancelledAt: '2026-05-19T00:00:00Z',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidScheduledPlanChangeError);
      expect((e as Error).message).toContain('sched-001');
      expect((e as Error).message).toContain('status=pending');
    }
  });
});
