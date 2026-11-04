/**
 * Spec 140 s2d (#736d) — `BroadcastsCascadePort` contract test.
 *
 * The port is the single F3 → F7 crossing for archival and erasure
 * (`src/modules/members/application/ports/broadcasts-cascade-port.ts`). Its
 * counts feed the `member_erased` payload and the
 * `broadcasts_cascade_orphan_stuck_total` metric, so a count the adapter
 * drops or invents is a lie in the erasure record (pdpa I-1 / I-3).
 *
 * Two layers, as the s2d plan review settled (architect L5):
 *   - `describeContract(name, makePort)` asserts only SHAPE invariants, run
 *     against both adapters: the outcome is in the closed set, every count is
 *     a non-negative integer, and every field of the returned arm is present.
 *   - the f7-only pass-through block stubs the F7 use case at its barrel
 *     boundary and asserts each count is copied through unchanged, the
 *     partial arm carries `deferredCount` / `unexpectedErrorCount`, and the
 *     `deadlineAt` / `onDispatchBegun` opts reach the use case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';
import type {
  BroadcastsCascadePort,
  CascadeResult,
} from '@/modules/members/application/ports/broadcasts-cascade-port';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { cancelInFlightBroadcastsForMember, makeCancelInFlightBroadcastsForMemberDeps } =
  vi.hoisted(() => ({
    cancelInFlightBroadcastsForMember: vi.fn(),
    makeCancelInFlightBroadcastsForMemberDeps: vi.fn(() => ({})),
  }));
vi.mock('@/modules/broadcasts', () => ({
  cancelInFlightBroadcastsForMember,
  makeCancelInFlightBroadcastsForMemberDeps,
}));

import {
  f7BroadcastsCascadeAdapter,
  noopBroadcastsCascadeAdapter,
} from '@/modules/members/infrastructure/adapters/broadcasts-cascade-adapter';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');

/** Every field of each arm, from `CascadeResult` — the closed set the port promises. */
const ARM_FIELDS: Readonly<Record<CascadeResult['outcome'], readonly string[]>> = {
  ok: [
    'outcome',
    'cancelledCount',
    'skippedConcurrentCount',
    'alreadySentCount',
    'resendDraftsCleared',
    'resendCopiesRetained',
    'audienceOrphansStuckCount',
  ],
  cascade_partial_failure: [
    'outcome',
    'cancelledCount',
    'skippedConcurrentCount',
    'unexpectedErrorCount',
    'alreadySentCount',
    'resendDraftsCleared',
    'resendCopiesRetained',
    'deferredCount',
    'audienceOrphansStuckCount',
  ],
  cascade_failed: ['outcome'],
};

/** A full F7 use-case output with distinct values, so a swapped field shows. */
function f7Output(overrides: Partial<Record<string, number>> = {}) {
  return {
    cancelledCount: 2,
    skippedConcurrentCount: 3,
    unexpectedErrorCount: 0,
    alreadySentCount: 5,
    resendDraftsCleared: 7,
    resendCopiesRetained: 11,
    deferredCount: 0,
    audienceOrphansStuckCount: 13,
    ...overrides,
  };
}

const OPTS = { initiatedByUserId: 'admin-7', requestId: 'req-7' } as const;

function assertShape(result: CascadeResult): void {
  expect(Object.keys(ARM_FIELDS)).toContain(result.outcome);
  const expected = ARM_FIELDS[result.outcome];
  expect(Object.keys(result).sort()).toEqual([...expected].sort());
  for (const [key, value] of Object.entries(result)) {
    if (key === 'outcome') continue;
    expect(Number.isInteger(value), `${key} is an integer`).toBe(true);
    expect(value as number, `${key} is non-negative`).toBeGreaterThanOrEqual(0);
  }
}

/**
 * Shape invariants any `BroadcastsCascadePort` implementation must hold.
 * `arrange` primes whatever the implementation reads (a no-op for the stub).
 */
function describeContract(
  name: string,
  makePort: () => BroadcastsCascadePort,
  arrange: (arm: CascadeResult['outcome']) => void,
  arms: readonly CascadeResult['outcome'][],
): void {
  describe(`BroadcastsCascadePort contract — ${name}`, () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it.each(arms)('the %s arm has the closed outcome, every field, non-negative integer counts', async (arm) => {
      arrange(arm);
      const result = await makePort().cancelInFlightForMember(tenant, memberId, OPTS);
      expect(result.outcome).toBe(arm);
      assertShape(result);
    });

    it('the erasure opts are accepted and the result keeps the shape', async () => {
      arrange(arms[0]!);
      const result = await makePort().cancelInFlightForMember(tenant, memberId, {
        ...OPTS,
        cancellationReason: 'gdpr_erasure_request',
        onDispatchBegun: 'delete_then_cancel',
        deadlineAt: new Date('2026-11-04T00:00:00.000Z'),
      });
      assertShape(result);
    });
  });
}

describeContract('noopBroadcastsCascadeAdapter', () => noopBroadcastsCascadeAdapter, () => {}, ['ok']);

describeContract(
  'f7BroadcastsCascadeAdapter (F7 use case stubbed at its barrel)',
  () => f7BroadcastsCascadeAdapter,
  (arm) => {
    if (arm === 'ok') {
      cancelInFlightBroadcastsForMember.mockResolvedValueOnce(ok(f7Output()));
    } else if (arm === 'cascade_partial_failure') {
      cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
        ok(f7Output({ unexpectedErrorCount: 4, deferredCount: 1 })),
      );
    } else {
      cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
        err({ kind: 'cascade.server_error', errClass: 'Error' }),
      );
    }
  },
  ['ok', 'cascade_partial_failure', 'cascade_failed'],
);

describe('f7BroadcastsCascadeAdapter — pass-through (#736d)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the ok arm copies every count through unchanged', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(ok(f7Output()));
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, OPTS);
    expect(result).toEqual({
      outcome: 'ok',
      cancelledCount: 2,
      skippedConcurrentCount: 3,
      alreadySentCount: 5,
      resendDraftsCleared: 7,
      resendCopiesRetained: 11,
      audienceOrphansStuckCount: 13,
    });
  });

  it('the partial arm carries deferredCount and unexpectedErrorCount beside the other counts', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(
      ok(f7Output({ unexpectedErrorCount: 4, deferredCount: 1 })),
    );
    const result = await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, OPTS);
    expect(result).toEqual({
      outcome: 'cascade_partial_failure',
      cancelledCount: 2,
      skippedConcurrentCount: 3,
      unexpectedErrorCount: 4,
      alreadySentCount: 5,
      resendDraftsCleared: 7,
      resendCopiesRetained: 11,
      deferredCount: 1,
      audienceOrphansStuckCount: 13,
    });
  });

  it('forwards deadlineAt and onDispatchBegun to the use case', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(ok(f7Output()));
    const deadlineAt = new Date('2026-11-04T00:00:20.000Z');
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, {
      ...OPTS,
      onDispatchBegun: 'delete_then_cancel',
      deadlineAt,
    });
    const input = cancelInFlightBroadcastsForMember.mock.calls[0]![1];
    expect(input.onDispatchBegun).toBe('delete_then_cancel');
    expect(input.deadlineAt).toBe(deadlineAt);
    expect(makeCancelInFlightBroadcastsForMemberDeps).toHaveBeenCalledWith('test-tenant');
  });

  it('an archive (neither opt set) passes neither key, so F7 keeps its defaults', async () => {
    cancelInFlightBroadcastsForMember.mockResolvedValueOnce(ok(f7Output()));
    await f7BroadcastsCascadeAdapter.cancelInFlightForMember(tenant, memberId, OPTS);
    const input = cancelInFlightBroadcastsForMember.mock.calls[0]![1];
    expect(Object.prototype.hasOwnProperty.call(input, 'onDispatchBegun')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, 'deadlineAt')).toBe(false);
  });
});
