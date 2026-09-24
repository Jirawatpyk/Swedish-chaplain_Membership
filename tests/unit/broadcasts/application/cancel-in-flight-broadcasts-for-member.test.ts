/**
 * Round 2 review (M4 / pr-test-analyzer C2) — unit coverage for the
 * F3-cascade use-case `cancelInFlightBroadcastsForMember`.
 *
 * The use-case has three error-classification branches with distinct
 * `cascadeOutcome` metric labels: `cancelled`, `concurrent_skip`,
 * `unexpected_error`. Round 2 review noted only integration coverage
 * (member-erasure-cascade.test.ts on live Neon) — these unit tests
 * lock the misclassification regression risk at the use-case level.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cascadeOutcomeSpy, auditEmitFailedSpy, auditEmitCountSpy } =
  vi.hoisted(() => ({
    cascadeOutcomeSpy: vi.fn(),
    auditEmitFailedSpy: vi.fn(),
    auditEmitCountSpy: vi.fn(),
  }));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: {
      ...actual.broadcastsMetrics,
      cascadeOutcome: cascadeOutcomeSpy,
      auditEmitFailed: auditEmitFailedSpy,
      auditEmitCount: auditEmitCountSpy,
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  CASCADE_CAS_RETRIES,
  cancelInFlightBroadcastsForMember,
} from '@/modules/broadcasts/application/use-cases/cancel-in-flight-broadcasts-for-member';
import { BroadcastConcurrentMutationError } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const broadcastIdA = '22222222-2222-4222-8222-222222222222';
const broadcastIdB = '33333333-3333-4333-8333-333333333333';

function makeBroadcastRow(opts: {
  broadcastId: string;
  status: 'submitted' | 'approved';
}) {
  return {
    broadcastId: opts.broadcastId as never,
    tenantId: 'test-tenant' as never,
    status: opts.status,
    resendBroadcastId: null,
    audienceImportId: null,
  } as never;
}

function makeDeps(overrides: {
  inFlightRows?: Array<{ broadcastId: string; status: 'submitted' | 'approved' }>;
  applyTransitionImpl?: (row: { broadcastId: string; expectedFrom: string }) => Promise<unknown>;
  auditEmitImpl?: () => Promise<void>;
  /**
   * T166 R-M3 — the re-read after a lost CAS. Default: the row moved on to
   * `sending` (the benign race the cascade was written for).
   */
  findByIdImpl?: (broadcastId: string) => Promise<{ status: string } | null>;
  /**
   * D1 — the row as read UNDER the lock inside the cancel's tx. Default: the
   * listed snapshot (no dispatch ids), i.e. nothing moved since the list.
   */
  lockedRowImpl?: (broadcastId: string) => Promise<Record<string, unknown> | null>;
}) {
  const rows = (overrides.inFlightRows ?? []).map(makeBroadcastRow);
  // F119 round-4 B6 — mirror db.transaction: a callback that returns COMMITS,
  // one that throws ROLLS BACK (and the throw leaves withTx). Recorded per tx,
  // so a test can prove what each attempt left behind.
  const txOutcomes: Array<'committed' | 'rolled_back'> = [];
  /** D1 — the repo calls in order, so a test can prove the lock precedes the read. */
  const calls: string[] = [];
  const snapshot = (broadcastId: string) =>
    (rows as Array<{ broadcastId: string }>).find((r) => r.broadcastId === broadcastId) ?? null;
  const broadcastsRepo = {
    listInFlightOwnedByMember: vi.fn(async () => rows),
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      try {
        const r = await fn({});
        txOutcomes.push('committed');
        return r;
      } catch (e) {
        txOutcomes.push('rolled_back');
        throw e;
      }
    }),
    lockForUpdate: vi.fn(async (_tx: unknown, _t: unknown, broadcastId: string) => {
      calls.push(`lock:${broadcastId}`);
      return null;
    }),
    findByIdInTx: vi.fn(async (_tx: unknown, _t: unknown, broadcastId: string) => {
      calls.push(`read:${broadcastId}`);
      return overrides.lockedRowImpl ? overrides.lockedRowImpl(broadcastId) : snapshot(broadcastId);
    }),
    applyTransition: vi.fn(async (_tx, _t, broadcastId, _to, _fields, expectedFrom) => {
      calls.push(`cas:${broadcastId as string}`);
      if (overrides.applyTransitionImpl) {
        return overrides.applyTransitionImpl({ broadcastId, expectedFrom });
      }
      return { broadcastId };
    }),
    findById: vi.fn(async (_t: unknown, broadcastId: string) =>
      overrides.findByIdImpl ? overrides.findByIdImpl(broadcastId) : { broadcastId, status: 'sending' },
    ),
  };
  const audit = {
    emit: vi.fn(async () => {
      if (overrides.auditEmitImpl) {
        await overrides.auditEmitImpl();
      }
    }),
  };
  const clock = { now: () => new Date('2026-05-03T00:00:00Z') };
  return {
    broadcastsRepo,
    audit,
    clock,
    txOutcomes,
    calls,
  } as never;
}

describe('cancelInFlightBroadcastsForMember (Round 2 M4)', () => {
  beforeEach(() => {
    cascadeOutcomeSpy.mockReset();
    auditEmitFailedSpy.mockReset();
    auditEmitCountSpy.mockReset();
  });

  it('happy path: emits cascadeOutcome="cancelled" once per row, returns counts', async () => {
    const deps = makeDeps({
      inFlightRows: [
        { broadcastId: broadcastIdA, status: 'submitted' },
        { broadcastId: broadcastIdB, status: 'approved' },
      ],
    });
    const result = await cancelInFlightBroadcastsForMember(deps, {
      tenant,
      memberId,
      requestId: 'req-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(2);
    expect(result.value.skippedConcurrentCount).toBe(0);
    expect(result.value.unexpectedErrorCount).toBe(0);
    const cancelledCalls = cascadeOutcomeSpy.mock.calls.filter(
      (c) => c[1] === 'cancelled',
    );
    expect(cancelledCalls).toHaveLength(2);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'unexpected_error'),
    ).toBe(false);
  });

  it('zero in-flight: returns zeros, emits no cascadeOutcome calls', async () => {
    const deps = makeDeps({ inFlightRows: [] });
    const result = await cancelInFlightBroadcastsForMember(deps, {
      tenant,
      memberId,
      requestId: 'req-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(0);
    expect(result.value.skippedConcurrentCount).toBe(0);
    expect(result.value.unexpectedErrorCount).toBe(0);
    expect(cascadeOutcomeSpy).not.toHaveBeenCalled();
  });

  it('BroadcastConcurrentMutationError: emits cascadeOutcome="concurrent_skip" + skips audit cancelled, continues to next row', async () => {
    const deps = makeDeps({
      inFlightRows: [
        { broadcastId: broadcastIdA, status: 'approved' },
        { broadcastId: broadcastIdB, status: 'submitted' },
      ],
      applyTransitionImpl: async ({ broadcastId }) => {
        if (broadcastId === broadcastIdA) {
          throw new BroadcastConcurrentMutationError(
            'test-tenant' as never,
            broadcastIdA as never,
            'sending',
          );
        }
        return { broadcastId };
      },
    });
    const result = await cancelInFlightBroadcastsForMember(deps, {
      tenant,
      memberId,
      requestId: 'req-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cancelledCount).toBe(1);
    expect(result.value.skippedConcurrentCount).toBe(1);
    expect(result.value.unexpectedErrorCount).toBe(0);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'concurrent_skip'),
    ).toBe(true);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'cancelled'),
    ).toBe(true);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'unexpected_error'),
    ).toBe(false);
  });

  /**
   * T166 R-M3 — the lost CAS used to be "benign" on the stated premise that the
   * winner moved the row on to `sending`. F119 added winners that leave it IN
   * PROGRESS (a new working copy → in_design, a send to the member, a
   * confirmation, the expiry …), where skipping it left the erased member's
   * E-Blast in the round — or dispatched it with `[redacted]` content after
   * the scrub. The cascade now re-reads and tries again from what it sees.
   */
  describe('T166 R-M3 — a lost CAS is re-read, never assumed benign', () => {
    const lostTo = (status: string) =>
      new BroadcastConcurrentMutationError('test-tenant' as never, broadcastIdA as never, status as never);

    it('the winner left the row in progress (in_design): the cascade re-reads and cancels it from THAT status', async () => {
      let calls = 0;
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async ({ broadcastId }) => {
          calls += 1;
          if (calls === 1) throw lostTo('approved');
          return { broadcastId };
        },
        findByIdImpl: async () => ({ status: 'in_design' }),
      }) as {
        broadcastsRepo: { applyTransition: ReturnType<typeof vi.fn> };
        audit: { emit: ReturnType<typeof vi.fn> };
        txOutcomes: string[];
      };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0 } });
      // Round-4 B6 — the lost attempt leaves its tx (rolled back); the retry commits.
      expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
      expect(deps.broadcastsRepo.applyTransition.mock.calls.map((c) => c[5])).toEqual(['approved', 'in_design']);
      expect(deps.audit.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'broadcast_cancelled', payload: expect.objectContaining({ previousStatus: 'in_design' }) }),
      );
    });

    it('still in progress after CASCADE_CAS_RETRIES re-reads → counted unexpected (the adapter reports cascade_partial_failure, the US2 reconciler re-drives)', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async () => {
          throw lostTo('awaiting_member_approval');
        },
        findByIdImpl: async () => ({ status: 'awaiting_member_approval' }),
      }) as { broadcastsRepo: { applyTransition: ReturnType<typeof vi.fn> }; txOutcomes: string[] };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1 } });
      expect(deps.broadcastsRepo.applyTransition).toHaveBeenCalledTimes(1 + CASCADE_CAS_RETRIES);
      // Round-4 B6 — every lost attempt rolls its tx back; none commits.
      expect(deps.txOutcomes).toEqual(Array.from({ length: 1 + CASCADE_CAS_RETRIES }, () => 'rolled_back'));
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
    });

    it('the re-read itself fails → counted unexpected (the row may still be in flight), never a benign skip', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async () => {
          throw lostTo('approved');
        },
        findByIdImpl: async () => {
          throw new Error('Neon: connection terminated');
        },
      });
      const result = await cancelInFlightBroadcastsForMember(deps, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1 } });
    });

    it('the row is gone on the re-read → a benign skip (nothing left in flight)', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }],
        applyTransitionImpl: async () => {
          throw lostTo('submitted');
        },
        findByIdImpl: async () => null,
      });
      const result = await cancelInFlightBroadcastsForMember(deps, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0 } });
    });
  });

  // F119 round-4 B6 — `cancelOnce` caught inside `withTx` and returned
  // normally, so an audit emit that threw AFTER `applyTransition` COMMITTED the
  // cancel with no `broadcast_cancelled` row. The throw now leaves the tx: the
  // cancel rolls back with its missing audit, the row stays in flight, it is
  // counted unexpected (the adapter reports cascade_partial_failure and the US2
  // reconciler re-drives it).
  it('round-4 B6: an audit emit that throws after the transition rolls the cancel back — never a cancel without its audit row', async () => {
    const deps = makeDeps({
      inFlightRows: [
        { broadcastId: broadcastIdA, status: 'approved' },
        { broadcastId: broadcastIdB, status: 'submitted' },
      ],
      auditEmitImpl: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) throw new TypeError('audit payload rejected');
        };
      })(),
    }) as { txOutcomes: string[]; broadcastsRepo: { applyTransition: ReturnType<typeof vi.fn> } };
    const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
    expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 1 } });
    expect(deps.broadcastsRepo.applyTransition).toHaveBeenCalledTimes(2);
    expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
    expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error', 'cancelled']);
    expect(auditEmitCountSpy).toHaveBeenCalledTimes(1);
  });

  // PR #392 review D1 — the cascade's status-only CAS cancelled an `approved`
  // row the dispatcher had already handed over (`attachResendIds` committed,
  // `sendBroadcast` not yet out — possibly not until the next tick): the row
  // read `cancelled` and freed the allowance while the email went out. It now
  // locks the row, reads it, and leaves a handed-over row to deliver — the
  // same skip as a row that moved on to `sending`.
  describe('D1 — an approved row the dispatcher already handed over is never cancelled', () => {
    it('locks the row BEFORE it reads it, then transitions — all inside the cancel tx', async () => {
      const deps = makeDeps({ inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }] }) as {
        calls: string[];
        broadcastsRepo: { lockForUpdate: ReturnType<typeof vi.fn>; findByIdInTx: ReturnType<typeof vi.fn> };
      };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0 } });
      expect(deps.calls).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, `cas:${broadcastIdA}`]);
      // The same tx handle for the lock and the read.
      expect(deps.broadcastsRepo.lockForUpdate.mock.calls[0]?.[0]).toBe(deps.broadcastsRepo.findByIdInTx.mock.calls[0]?.[0]);
    });

    it.each([
      ['legacy leg — resend_broadcast_id set', { resendBroadcastId: 'rb-live-1', audienceImportId: null }],
      ['import leg — both ids set', { resendBroadcastId: 'rb-live-2', audienceImportId: 'imp-live-1' }],
    ])('%s under the lock → skipped (concurrent_skip + broadcast_concurrent_action_blocked), no transition, the next row still cancels', async (_leg, ids) => {
      const deps = makeDeps({
        inFlightRows: [
          { broadcastId: broadcastIdA, status: 'approved' },
          { broadcastId: broadcastIdB, status: 'submitted' },
        ],
        lockedRowImpl: async (id) =>
          id === broadcastIdA
            ? { broadcastId: id, status: 'approved', ...ids }
            : { broadcastId: id, status: 'submitted', resendBroadcastId: null, audienceImportId: null },
      }) as {
        calls: string[];
        txOutcomes: string[];
        audit: { emit: ReturnType<typeof vi.fn> };
      };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 1, unexpectedErrorCount: 0 } });
      expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
      // The skipped attempt wrote nothing; its tx ends without a transition.
      expect(deps.txOutcomes).toEqual(['committed', 'committed']);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['concurrent_skip', 'cancelled']);
      expect(deps.audit.emit).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          eventType: 'broadcast_concurrent_action_blocked',
          payload: expect.objectContaining({ broadcastId: broadcastIdA, observedStatus: 'approved', dispatchBegun: true }),
        }),
      );
      expect(
        deps.audit.emit.mock.calls.some(
          (c) => (c[1] as { eventType: string; payload: { broadcastId: string } }).eventType === 'broadcast_cancelled' &&
            (c[1] as { payload: { broadcastId: string } }).payload.broadcastId === broadcastIdA,
        ),
      ).toBe(false);
    });

    it('import leg with ONLY audience_import_id (no Resend broadcast yet) → cancelled: the next audience tick sees `cancelled` under its lock, and skipping would let it mint the email from the scrubbed `[redacted]` row', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: async (id) => ({ broadcastId: id, status: 'approved', resendBroadcastId: null, audienceImportId: 'imp-live-1' }),
      }) as { calls: string[] };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0 } });
      expect(deps.calls).toContain(`cas:${broadcastIdA}`);
    });

    it('the row is gone under the lock → no transition; the re-read confirms it and it is a benign skip', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }],
        lockedRowImpl: async () => null,
        findByIdImpl: async () => null,
      }) as { calls: string[] };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0 } });
      expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
    });
  });

  it('non-concurrent throw: emits cascadeOutcome="unexpected_error" + cascade continues', async () => {
    const deps = makeDeps({
      inFlightRows: [
        { broadcastId: broadcastIdA, status: 'approved' },
        { broadcastId: broadcastIdB, status: 'submitted' },
      ],
      applyTransitionImpl: async ({ broadcastId }) => {
        if (broadcastId === broadcastIdA) {
          throw new Error('Neon: connection terminated');
        }
        return { broadcastId };
      },
    });
    const result = await cancelInFlightBroadcastsForMember(deps, {
      tenant,
      memberId,
      requestId: 'req-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Second row still cancels — best-effort cascade.
    expect(result.value.cancelledCount).toBe(1);
    expect(result.value.skippedConcurrentCount).toBe(0);
    expect(result.value.unexpectedErrorCount).toBe(1);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'unexpected_error'),
    ).toBe(true);
    expect(
      cascadeOutcomeSpy.mock.calls.some((c) => c[1] === 'concurrent_skip'),
    ).toBe(false);
  });

  it('listInFlight throws (outer try): returns Result.err — adapter translates to outcome="cascade_failed"', async () => {
    const deps = makeDeps({}) as {
      broadcastsRepo: {
        listInFlightOwnedByMember: ReturnType<typeof vi.fn>;
        withTx: ReturnType<typeof vi.fn>;
        applyTransition: ReturnType<typeof vi.fn>;
      };
      audit: { emit: ReturnType<typeof vi.fn> };
      clock: { now: () => Date };
    };
    deps.broadcastsRepo.listInFlightOwnedByMember = vi.fn(async () => {
      throw new Error('Neon: pool exhausted');
    });
    const result = await cancelInFlightBroadcastsForMember(deps as never, {
      tenant,
      memberId,
      requestId: 'req-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cascade.server_error');
    expect(result.error.message).toContain('pool exhausted');
  });
});
