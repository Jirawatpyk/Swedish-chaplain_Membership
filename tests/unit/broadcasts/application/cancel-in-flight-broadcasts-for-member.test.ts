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
import { REPROBE_PAUSE_MS } from '@/modules/broadcasts/application/use-cases/_reprobe-pause';
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
  /** Spec 139 — what `deleteBroadcastOnce` answers (erasure mode only). Default: `deleted`. */
  deleteOutcome?: 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other';
  /**
   * Spec 139 — what the bounded probe (`retrieveBroadcastOnce`) after a DELETE
   * 404 or 403 answers; `'throws'` = a fake that breaks its never-throws
   * contract. Default: `sent`.
   */
  probe?: 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed' | 'unknown' | 'not_found' | 'retryable' | 'other' | 'throws';
  /**
   * Spec 139 P7 — broadcasts this member already holds an `already_sent`
   * evidence row for. The fake store also records every evidence row the
   * cascade emits, so the count it answers is DERIVED, as the repo's is.
   */
  alreadySentEvidence?: ReadonlyArray<string>;
  /** Spec 139 P7 — the end-of-cascade count read fails. */
  evidenceCountThrows?: boolean;
  /**
   * Spec 140 s1 — the member's TERMINAL rows that still hold a Resend id, as
   * `listTerminalWithResendIdOwnedByMember` answers them (erasure mode only).
   * Default: none. `'throws'` = the read fails.
   */
  terminalRows?: ReadonlyArray<{ broadcastId: string; status: string; resendBroadcastId: string }> | 'throws';
  /** Spec 140 s1 — a per-Resend-id DELETE answer; falls back to `deleteOutcome`. */
  deleteOutcomeById?: Readonly<Record<string, 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other' | 'throws'>>;
}) {
  const rows = (overrides.inFlightRows ?? []).map(makeBroadcastRow);
  // F119 round-4 B6 — mirror db.transaction: a callback that returns COMMITS,
  // one that throws ROLLS BACK (and the throw leaves withTx). Recorded per tx,
  // so a test can prove what each attempt left behind.
  const txOutcomes: Array<'committed' | 'rolled_back'> = [];
  /** D1 — the repo calls in order, so a test can prove the lock precedes the read. */
  const calls: string[] = [];
  /** Spec 139 — how many txs are open, so a test can prove a Resend call ran outside the row lock. */
  let openTx = 0;
  const snapshot = (broadcastId: string) =>
    (rows as Array<{ broadcastId: string }>).find((r) => r.broadcastId === broadcastId) ?? null;
  const broadcastsRepo = {
    listInFlightOwnedByMember: vi.fn(async () => rows),
    listTerminalWithResendIdOwnedByMember: vi.fn(async () => {
      if (overrides.terminalRows === 'throws') throw new Error('Neon: terminal list failed');
      return overrides.terminalRows ?? [];
    }),
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      openTx += 1;
      try {
        const r = await fn({});
        txOutcomes.push('committed');
        return r;
      } catch (e) {
        txOutcomes.push('rolled_back');
        throw e;
      } finally {
        openTx -= 1;
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
    readAlreadySentEvidenceInTx: vi.fn(
      async (_tx: unknown, _t: unknown, query: { memberId: string; broadcastId: string | null }) => {
        // Read on the emit's tx, or a concurrent re-drive could slip between them.
        calls.push(`evidence:${query.broadcastId ?? 'count'}${openTx > 0 ? '' : ':no-tx'}`);
        if (query.broadcastId === null && overrides.evidenceCountThrows === true) throw new Error('Neon: count failed');
        return {
          broadcastRecorded: query.broadcastId !== null && evidence.has(query.broadcastId),
          memberBroadcastCount: evidence.size,
        };
      },
    ),
  };
  /** Spec 139 P7 — the `already_sent` evidence rows this member holds, by broadcast. */
  const evidence = new Set<string>(overrides.alreadySentEvidence ?? []);
  const audit = {
    emit: vi.fn(async (_tx: unknown, event: { payload: { broadcastId?: unknown; resendOutcome?: unknown } }) => {
      if (overrides.auditEmitImpl) {
        await overrides.auditEmitImpl();
      }
      if (event.payload.resendOutcome === 'already_sent') evidence.add(String(event.payload.broadcastId));
    }),
  };
  const clock = { now: () => new Date('2026-05-03T00:00:00Z') };
  // Spec 139 — the gateway the erasure mode calls under the row lock. Recorded
  // into `calls` so a test can prove the DELETE and the probe sit between the
  // locked read and the CAS — both bounded, both under the lock that did the
  // DELETE (a call outside any tx is marked `:no-lock`).
  const broadcastsGateway = {
    deleteBroadcastOnce: vi.fn(async (id: string) => {
      calls.push(`delete:${id}${openTx > 0 ? '' : ':no-lock'}`);
      const byId = overrides.deleteOutcomeById?.[id];
      if (byId === 'throws') throw new Error('a fake that breaks the never-throws contract');
      return { kind: byId ?? overrides.deleteOutcome ?? 'deleted' };
    }),
    retrieveBroadcastOnce: vi.fn(async (id: string) => {
      calls.push(`probe:${id}${openTx > 0 ? '' : ':no-lock'}`);
      const probe = overrides.probe ?? 'sent';
      if (probe === 'throws') throw new Error('a fake that breaks the never-throws contract');
      if (probe === 'not_found' || probe === 'retryable' || probe === 'other') return { kind: probe };
      return { kind: 'present' as const, status: probe };
    }),
  };
  // Review round 2 (code-review #1) — the pause between a DELETE 404 and its
  // confirming GET, recorded instead of waited.
  const pauseBeforeReprobe = vi.fn(async (ms: number) => {
    calls.push(`pause:${ms}${openTx > 0 ? '' : ':no-lock'}`);
  });
  return {
    broadcastsRepo,
    audit,
    clock,
    broadcastsGateway,
    pauseBeforeReprobe,
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
    expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, `cas:${broadcastIdA}`]);
      // The same tx handle for the lock and the read.
      expect(deps.broadcastsRepo.lockForUpdate.mock.calls[0]?.[0]).toBe(deps.broadcastsRepo.findByIdInTx.mock.calls[0]?.[0]);
    });

    // Spec 139 DE4 — the ARCHIVE mode (the default, `onDispatchBegun` unset:
    // archive and bulk archive). The erasure mode's flipped arms are in the
    // `spec 139 DE2` block below.
    it.each([
      ['legacy leg — resend_broadcast_id set', { resendBroadcastId: 'rb-live-1', audienceImportId: null }],
      ['import leg — both ids set', { resendBroadcastId: 'rb-live-2', audienceImportId: 'imp-live-1' }],
    ])('archive mode, %s under the lock → skipped (concurrent_skip + broadcast_concurrent_action_blocked), no transition, no Resend call, the next row still cancels', async (_leg, ids) => {
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
      // DE4 — archive never deletes at Resend.
      expect(deps.calls.filter((c) => c.startsWith('delete:') || c.startsWith('probe:'))).toEqual([]);
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toContain(`cas:${broadcastIdA}`);
    });

    it('the row is gone under the lock → no transition; the re-read confirms it and it is a benign skip', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }],
        lockedRowImpl: async () => null,
        findByIdImpl: async () => null,
      }) as { calls: string[] };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
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
    // Review round 4 (code-review #8) — the class only: a message can embed
    // SQL parameter values, and the adapter logs this field.
    expect(result.error.message).toBe('Error');
  });

  /**
   * Spec 139 DE2 — the ERASURE mode (`onDispatchBegun: 'delete_then_cancel'`),
   * review round 1's table. Every decision on the row is made UNDER the row
   * lock that did the DELETE: a cancel decided later, on a status-only CAS,
   * could follow an import tick that re-minted from pre-scrub content.
   *
   * | DELETE (once) | GET once, under the lock    | decision                                   |
   * | 200 deleted   | —                           | cancel, `resendOutcome: 'deleted'`         |
   * | 404 absent    | not_found                   | cancel, `'absent'` (two not-founds)        |
   * | 404 absent    | queued / sending / sent     | no row write; `already_sent` evidence      |
   * | 404 absent    | draft / cancelled / unknown | unexpected (an inconsistent answer)        |
   * | 403 forbidden | queued / sending / sent     | no row write; `already_sent` evidence      |
   * | 403 forbidden | cancelled                   | cancel, `'cancelled_at_resend'`            |
   * | 403 forbidden | draft / not_found / unknown | unexpected (a restricted key; fail closed) |
   * | either call retryable / other / timeout     | unexpected                                 |
   *
   * The evidence row is written on its own tx after the lock tx, under the
   * evidence advisory lock, once per broadcast; `alreadySentCount` is DERIVED
   * at the end from the evidence the member holds (P7), never accumulated.
   */
  describe('spec 139 DE2 — the erasure mode decides every row under the lock that did the DELETE', () => {
    const erasureInput = { tenant, memberId, requestId: 'req-1', onDispatchBegun: 'delete_then_cancel' as const };
    const handedRow = (ids: Record<string, unknown> = {}) => async (id: string) =>
      id === broadcastIdA
        ? { broadcastId: id, status: 'approved', resendBroadcastId: 'rb-live-1', audienceImportId: null, ...ids }
        : { broadcastId: id, status: 'submitted', resendBroadcastId: null, audienceImportId: null };
    type Seen = {
      calls: string[];
      txOutcomes: string[];
      audit: { emit: ReturnType<typeof vi.fn> };
      broadcastsRepo: { readAlreadySentEvidenceInTx: ReturnType<typeof vi.fn> };
      broadcastsGateway: { deleteBroadcastOnce: ReturnType<typeof vi.fn>; retrieveBroadcastOnce: ReturnType<typeof vi.fn> };
    };
    const eventsOf = (deps: Seen, eventType: string) =>
      deps.audit.emit.mock.calls.filter((c) => (c[1] as { eventType: string }).eventType === eventType);
    const lockA = [`lock:${broadcastIdA}`, `read:${broadcastIdA}`, 'delete:rb-live-1'];
    /** Review round 2 (code-review #1) — the re-probe pause follows a DELETE 404 only. */
    const pauseAfter = (deleteOutcome: 'absent' | 'forbidden') => (deleteOutcome === 'absent' ? [`pause:${REPROBE_PAUSE_MS}`] : []);

    it('DELETE answers deleted → cancelled in the same tx, no probe; broadcast_cancelled carries resendOutcome deleted', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'deleted',
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual([...lockA, `cas:${broadcastIdA}`, 'evidence:count']);
      expect(deps.broadcastsGateway.retrieveBroadcastOnce).not.toHaveBeenCalled();
      // The cancel tx, then the count read.
      expect(deps.txOutcomes).toEqual(['committed', 'committed']);
      const [cancelled] = eventsOf(deps, 'broadcast_cancelled');
      expect(cancelled?.[1]).toMatchObject({ payload: expect.objectContaining({ broadcastId: broadcastIdA, resendOutcome: 'deleted' }) });
      expect(eventsOf(deps, 'broadcast_concurrent_action_blocked')).toEqual([]);
    });

    it('DELETE answers absent and the probe UNDER the lock says not_found (two not-founds) → cancelled, resendOutcome absent', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'absent',
        probe: 'not_found',
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      // Review round 2 (code-review #1) — REPROBE_PAUSE_MS between the 404 and
      // the GET, under the lock, as the import leg waits before its re-probe.
      expect(deps.calls).toEqual([...lockA, `pause:${REPROBE_PAUSE_MS}`, 'probe:rb-live-1', `cas:${broadcastIdA}`, 'evidence:count']);
      expect(deps.txOutcomes).toEqual(['committed', 'committed']);
      const [cancelled] = eventsOf(deps, 'broadcast_cancelled');
      expect(cancelled?.[1]).toMatchObject({ payload: expect.objectContaining({ broadcastId: broadcastIdA, resendOutcome: 'absent' }) });
    });

    it('DELETE answers forbidden and the probe says cancelled → cancelled, resendOutcome cancelled_at_resend (a cancelled broadcast can never be sent)', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'forbidden',
        probe: 'cancelled',
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual([...lockA, 'probe:rb-live-1', `cas:${broadcastIdA}`, 'evidence:count']);
      const [cancelled] = eventsOf(deps, 'broadcast_cancelled');
      expect(cancelled?.[1]).toMatchObject({ payload: expect.objectContaining({ resendOutcome: 'cancelled_at_resend' }) });
    });

    describe.each(['absent', 'forbidden'] as const)('DELETE answers %s', (deleteOutcome) => {
      it.each(['queued', 'sending', 'sent'] as const)(
        'and the probe under the lock says %s → already sent: the lock tx ends with no row write, the evidence row on its own tx, alreadySentCount derived 1',
        async (status) => {
          const deps = makeDeps({
            inFlightRows: [
              { broadcastId: broadcastIdA, status: 'approved' },
              { broadcastId: broadcastIdB, status: 'submitted' },
            ],
            lockedRowImpl: handedRow(),
            deleteOutcome,
            probe: status,
          }) as unknown as Seen;
          const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
          expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 1, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
          expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
          // The probe ran under the row lock; the evidence check on a tx of its own after it.
          // A pause only after a 404, never after a 403.
          expect(deps.calls.slice(0, deleteOutcome === 'absent' ? 6 : 5)).toEqual([
            ...lockA,
            ...pauseAfter(deleteOutcome),
            'probe:rb-live-1',
            `evidence:${broadcastIdA}`,
          ]);
          expect(deps.calls.at(-1)).toBe('evidence:count');
          // A's lock tx (nothing written), A's evidence tx, B's cancel, the count read.
          expect(deps.txOutcomes).toEqual(['committed', 'committed', 'committed', 'committed']);
          const blocked = eventsOf(deps, 'broadcast_concurrent_action_blocked');
          expect(blocked).toHaveLength(1);
          // P6 — durable: on the cascade's tx, never `emit(null)`.
          expect(blocked[0]![0]).not.toBeNull();
          expect(blocked[0]![1]).toMatchObject({
            payload: expect.objectContaining({
              broadcastId: broadcastIdA,
              memberId,
              dispatchBegun: true,
              resendOutcome: 'already_sent',
              observedResendStatus: status,
              observedStatus: 'approved',
            }),
          });
          // CR#9 — its own metric label, not `concurrent_skip`.
          expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['already_sent', 'cancelled']);
        },
      );

      it.each(['retryable', 'other', 'throws'] as const)(
        'and the probe answers %s → unexpected: the lock tx rolls back, nothing written',
        async (probe) => {
          const deps = makeDeps({
            inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
            lockedRowImpl: handedRow(),
            deleteOutcome,
            probe,
          }) as unknown as Seen;
          const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
          expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
          expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
          expect(deps.calls).toContain('probe:rb-live-1');
          expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
          expect(deps.audit.emit).not.toHaveBeenCalled();
          expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
        },
      );
    });

    it.each([
      ['absent', 'draft'],
      // Coordinator ruling (review round 1): a DELETE that said absent followed
      // by a GET that finds the resource is inconsistent, and decides nothing.
      ['absent', 'cancelled'],
      ['absent', 'unknown'],
      // A restricted key answers 403 too: only a positive probe is believed.
      ['forbidden', 'draft'],
      ['forbidden', 'not_found'],
      ['forbidden', 'unknown'],
    ] as const)('DELETE answers %s but the probe says %s → unexpected (fail closed): the lock tx rolls back, nothing written', async (deleteOutcome, probe) => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome,
        probe,
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual([...lockA, ...pauseAfter(deleteOutcome), 'probe:rb-live-1', 'evidence:count']);
      expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
      expect(deps.audit.emit).not.toHaveBeenCalled();
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
    });

    it.each(['retryable', 'other'] as const)(
      'DELETE answers %s (a timeout included) → unexpected, no probe: the row unchanged, nothing written — the reconciler drives it again',
      async (outcome) => {
        const deps = makeDeps({
          inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
          lockedRowImpl: handedRow(),
          deleteOutcome: outcome,
        }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
        expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
        expect(deps.broadcastsGateway.retrieveBroadcastOnce).not.toHaveBeenCalled();
        expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
        expect(deps.audit.emit).not.toHaveBeenCalled();
      },
    );

    it('a re-erasure (manual, or the reconcile-erasures re-drive) whose evidence row already exists writes no second one; alreadySentCount still counts the broadcast', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'forbidden',
        probe: 'sent',
        alreadySentEvidence: [broadcastIdA],
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      // member_erased must still say this E-Blast went out.
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 1, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.audit.emit).not.toHaveBeenCalled();
      expect(deps.calls).toEqual([...lockA, 'probe:rb-live-1', `evidence:${broadcastIdA}`, 'evidence:count']);
      expect(deps.txOutcomes).toEqual(['committed', 'committed', 'committed']);
    });

    it('P7 — the count is DERIVED: a re-drive with nothing left in flight still reports every broadcast the member holds evidence for', async () => {
      // The 403'd row moved on to `sending` after the first run, so it is no
      // longer in flight; an accumulated count would say 0 here.
      const deps = makeDeps({ inFlightRows: [], alreadySentEvidence: [broadcastIdA, broadcastIdB] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 2, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual(['evidence:count']);
      expect(deps.broadcastsRepo.readAlreadySentEvidenceInTx).toHaveBeenCalledWith(expect.anything(), tenant.slug, { memberId, broadcastId: null });
    });

    it('P7 — the archive mode never reads the evidence: its count is 0', async () => {
      const deps = makeDeps({ inFlightRows: [], alreadySentEvidence: [broadcastIdA] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.broadcastsRepo.readAlreadySentEvidenceInTx).not.toHaveBeenCalled();
    });

    it('P7 — the count read fails → unexpected (member_erased is withheld), never a whole-cascade server error', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdB, status: 'submitted' }],
        evidenceCountThrows: true,
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
    });

    // Review round 2 (reliability LOW-1) — ONE evidence row, not two: the
    // best-effort skip row (`emit(null)`) said "concurrent transition" about a
    // send the erasure could not stop. Only the durable `already_sent` row is
    // written, and the row counts as already sent, never as a benign skip.
    it('P7 (a) — a lost race whose re-read finds the send started writes ONLY the already_sent evidence row (residual 8c), counted as already sent, not as a skip', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async ({ broadcastId }) => {
          throw new BroadcastConcurrentMutationError('test-tenant' as never, broadcastId as never, 'approved');
        },
        findByIdImpl: async () => ({ status: 'partially_sent' }),
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 1, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['already_sent']);
      const blocked = eventsOf(deps, 'broadcast_concurrent_action_blocked');
      // The durable evidence row only, on its own tx.
      expect(blocked).toHaveLength(1);
      expect(blocked[0]![0]).not.toBeNull();
      expect(blocked[0]![1]).toMatchObject({
        payload: expect.objectContaining({
          broadcastId: broadcastIdA,
          memberId,
          resendOutcome: 'already_sent',
          observedStatus: 'partially_sent',
          observedResendStatus: null,
        }),
      });
    });

    // senior-tester (round 3) — the evidence write on the lost-race path is
    // the only record of that send; if it fails the row must count
    // unexpected, so `member_erased` is withheld and the erasure re-driven.
    it('P7 (a) — the lost-race evidence write fails → unexpected, nothing counted as sent', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async ({ broadcastId }) => {
          throw new BroadcastConcurrentMutationError('test-tenant' as never, broadcastId as never, 'approved');
        },
        findByIdImpl: async () => ({ status: 'sending' }),
        auditEmitImpl: async () => {
          throw new TypeError('audit payload rejected');
        },
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result.ok).toBe(true);
      expect(result.ok ? result.value.unexpectedErrorCount : null).toBe(1);
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).not.toContain('already_sent');
    });

    it('P7 (a) — the archive mode writes no evidence on a lost race to a started send', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        applyTransitionImpl: async ({ broadcastId }) => {
          throw new BroadcastConcurrentMutationError('test-tenant' as never, broadcastId as never, 'approved');
        },
        findByIdImpl: async () => ({ status: 'sending' }),
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(eventsOf(deps, 'broadcast_concurrent_action_blocked')).toHaveLength(1);
    });

    it('403 + already sent, but the evidence row cannot be written → unexpected (P6): the reconciler drives it again', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'forbidden',
        probe: 'sent',
        auditEmitImpl: async () => {
          throw new TypeError('audit payload rejected');
        },
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.txOutcomes).toEqual(['committed', 'rolled_back', 'committed']);
    });

    it('DELETE 200, then the cancel tx rolls back (its audit write fails) → unexpected; the draft is gone, so a tick can only 404', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'deleted',
        auditEmitImpl: async () => {
          throw new TypeError('audit payload rejected');
        },
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.calls).toEqual([...lockA, `cas:${broadcastIdA}`, 'evidence:count']);
      expect(deps.txOutcomes).toEqual(['rolled_back', 'committed']);
    });

    // Review round 2 (M-NEW-1) — the snapshot said `submitted`, but under the
    // lock the row is `approved` with an id (the dispatcher approved and
    // persisted in between). The CAS on the snapshot status cannot land, so a
    // DELETE before it would be wasted — and the retry's DELETE would then meet
    // a 404 for a draft THIS cascade deleted. The attempt throws the concurrent
    // error BEFORE any Resend call; the re-read retries from `approved`.
    it('the locked row is not at the snapshot status → no Resend call on that attempt; the retry from the status read DELETEs once → deleted', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }],
        lockedRowImpl: async (id) => ({ broadcastId: id, status: 'approved', resendBroadcastId: 'rb-live-1', audienceImportId: null }),
        // The real CAS: it matches only the status the row is at.
        applyTransitionImpl: async ({ broadcastId, expectedFrom }) => {
          if (expectedFrom !== 'approved') {
            throw new BroadcastConcurrentMutationError('test-tenant' as never, broadcastId as never, expectedFrom as never);
          }
          return { broadcastId };
        },
        findByIdImpl: async () => ({ status: 'approved' }),
        deleteOutcome: 'deleted',
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.broadcastsGateway.deleteBroadcastOnce).toHaveBeenCalledTimes(1);
      expect(deps.calls).toEqual([
        `lock:${broadcastIdA}`,
        `read:${broadcastIdA}`,
        ...lockA,
        `cas:${broadcastIdA}`,
        'evidence:count',
      ]);
      const [cancelled] = eventsOf(deps, 'broadcast_cancelled');
      expect(cancelled?.[1]).toMatchObject({
        payload: expect.objectContaining({ previousStatus: 'approved', resendOutcome: 'deleted' }),
      });
    });

    it('an EMPTY id is not an id → cancelled without any Resend call', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow({ resendBroadcastId: '' }),
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
    });

    it('a row with no Resend id is cancelled exactly as before — no Resend call', async () => {
      const deps = makeDeps({ inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0, resendDraftsCleared: 0, resendCopiesRetained: 0, deferredCount: 0 } });
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
    });
  });

  /**
   * Spec 140 s1 (ED1–ED3, plan.md § State table) — the erasure mode also
   * reaches the member's TERMINAL rows (outside the in-progress set, not
   * `sent`) that still hold a Resend id. No dispatch tick works such a row, so
   * there is no row lock: one bounded DELETE per row, and after a 403 one
   * bounded GET.
   *
   * | DELETE once         | GET once                                    | outcome    |
   * | deleted / absent    | —                                           | cleared    |
   * | forbidden           | cancelled / failed / queued / sending / sent | retained   |
   * | forbidden           | draft / unknown / not_found / retryable / other | unexpected |
   * | retryable / other   | —                                           | unexpected |
   *
   * A retained copy is NOT `already_sent` evidence: no evidence row is written,
   * so `broadcasts_already_sent_count` does not move (ED2). An unexpected row
   * counts into `unexpectedErrorCount`, so `member_erased` is withheld and the
   * reconciler drives the erasure again (ED3).
   */
  describe('spec 140 s1 — the erasure mode deletes the drafts its terminal rows still point to', () => {
    const erasureInput = { tenant, memberId, requestId: 'req-1', onDispatchBegun: 'delete_then_cancel' as const };
    const terminalA = { broadcastId: broadcastIdA, status: 'failed_to_dispatch', resendBroadcastId: 'rb-term-a' };
    const terminalB = { broadcastId: broadcastIdB, status: 'cancelled', resendBroadcastId: 'rb-term-b' };
    type Seen = {
      calls: string[];
      txOutcomes: string[];
      audit: { emit: ReturnType<typeof vi.fn> };
      broadcastsRepo: { listTerminalWithResendIdOwnedByMember: ReturnType<typeof vi.fn> };
      broadcastsGateway: { deleteBroadcastOnce: ReturnType<typeof vi.fn>; retrieveBroadcastOnce: ReturnType<typeof vi.fn> };
      pauseBeforeReprobe: ReturnType<typeof vi.fn>;
    };
    const value = (v: Partial<Record<string, number>>) => ({
      ok: true,
      value: {
        cancelledCount: 0,
        skippedConcurrentCount: 0,
        unexpectedErrorCount: 0,
        alreadySentCount: 0,
        resendDraftsCleared: 0,
        resendCopiesRetained: 0,
        deferredCount: 0,
        ...v,
      },
    });

    it.each(['deleted', 'absent'] as const)(
      'DELETE answers %s → cleared (+1 resendDraftsCleared): no probe, no pause, no row lock, no row write, no audit row',
      async (deleteOutcome) => {
        const deps = makeDeps({ terminalRows: [terminalA], deleteOutcome }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual(value({ resendDraftsCleared: 1 }));
        // Outside every tx: the terminal row takes no lock.
        expect(deps.calls).toEqual(['delete:rb-term-a:no-lock', 'evidence:count']);
        expect(deps.broadcastsGateway.retrieveBroadcastOnce).not.toHaveBeenCalled();
        expect(deps.pauseBeforeReprobe).not.toHaveBeenCalled();
        expect(deps.audit.emit).not.toHaveBeenCalled();
        expect(deps.broadcastsRepo.listTerminalWithResendIdOwnedByMember).toHaveBeenCalledWith(tenant.slug, memberId);
        expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['terminal_draft_cleared']);
      },
    );

    it.each(['cancelled', 'failed'] as const)(
      'DELETE answers forbidden and the GET says %s → an UNSENT copy retained at the processor (+1 resendCopiesRetained), NOT already-sent evidence',
      async (probe) => {
        const deps = makeDeps({ terminalRows: [terminalA], deleteOutcome: 'forbidden', probe }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        // ED2 — `alreadySentCount` (→ broadcasts_already_sent_count) stays 0.
        expect(result).toEqual(value({ resendCopiesRetained: 1 }));
        expect(deps.calls).toEqual(['delete:rb-term-a:no-lock', 'probe:rb-term-a:no-lock', 'evidence:count']);
        // No pause after a 403, and no `broadcast_concurrent_action_blocked` evidence row.
        expect(deps.pauseBeforeReprobe).not.toHaveBeenCalled();
        expect(deps.audit.emit).not.toHaveBeenCalled();
        expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['terminal_copy_retained']);
      },
    );

    // Review round 1 (code-review #1/#2, pdpa M-1, security L3) — a handed copy
    // is a disclosure (residual 8c), recorded through the SAME evidence path as
    // the in-flight arm: its own tx, the evidence advisory lock, once per
    // broadcast. It is not a retained copy, so it is counted once, in
    // `alreadySentCount` (derived from the distinct evidence rows).
    it.each(['queued', 'sending', 'sent'] as const)(
      'DELETE answers forbidden and the GET says %s → already-sent evidence (8c), not retained',
      async (probe) => {
        const deps = makeDeps({ terminalRows: [terminalA], deleteOutcome: 'forbidden', probe }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual(value({ alreadySentCount: 1 }));
        expect(deps.calls).toEqual(['delete:rb-term-a:no-lock', 'probe:rb-term-a:no-lock', `evidence:${broadcastIdA}`, 'evidence:count']);
        const blocked = deps.audit.emit.mock.calls.filter((c) => (c[1] as { eventType: string }).eventType === 'broadcast_concurrent_action_blocked');
        expect(blocked).toHaveLength(1);
        expect(blocked[0]![0]).not.toBeNull();
        expect(blocked[0]![1]).toMatchObject({
          payload: expect.objectContaining({
            broadcastId: broadcastIdA,
            memberId,
            resendOutcome: 'already_sent',
            observedStatus: 'failed_to_dispatch',
            observedResendStatus: probe,
          }),
        });
        expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['already_sent']);
      },
    );

    it('a handed copy whose evidence row already exists (an earlier run, or the in-flight arm) is not written twice', async () => {
      const deps = makeDeps({ terminalRows: [terminalA], deleteOutcome: 'forbidden', probe: 'sent', alreadySentEvidence: [broadcastIdA] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual(value({ alreadySentCount: 1 }));
      expect(deps.audit.emit).not.toHaveBeenCalled();
    });

    it('a handed copy whose evidence write fails → unexpected (member_erased withheld), nothing counted as sent', async () => {
      const deps = makeDeps({
        terminalRows: [terminalA],
        deleteOutcome: 'forbidden',
        probe: 'queued',
        auditEmitImpl: async () => {
          throw new TypeError('audit payload rejected');
        },
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual(value({ unexpectedErrorCount: 1 }));
    });

    // Review round 1 (reliability L-2, code-review #3) — a row the in-flight
    // loop settled at Resend in THIS run is not DELETEd again; its outcome is
    // counted from the in-flight settlement, so the counts match a re-drive's.
    it.each([
      ['deleted', undefined, { cancelledCount: 1, resendDraftsCleared: 1 }, 'terminal_draft_cleared'],
      ['forbidden', 'cancelled', { cancelledCount: 1, resendCopiesRetained: 1 }, 'terminal_copy_retained'],
    ] as const)('an in-flight row settled at Resend this run (DELETE %s) is not DELETEd again by the terminal pass', async (deleteOutcome, probe, counts, label) => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: async (id) => ({ broadcastId: id, status: 'approved', resendBroadcastId: 'rb-live-1', audienceImportId: null }),
        // The cascade has just cancelled it: the terminal list now holds it.
        terminalRows: [{ broadcastId: broadcastIdA, status: 'cancelled', resendBroadcastId: 'rb-live-1' }],
        deleteOutcome,
        ...(probe !== undefined ? { probe } : {}),
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual(value(counts));
      expect(deps.broadcastsGateway.deleteBroadcastOnce).toHaveBeenCalledTimes(1);
      // Review round 3 (code-review #5) — metric parity with a re-drive, which
      // DELETEs the row and counts it under the terminal label.
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toContain(label);
    });

    // Review round 1 (reliability H-1, code-review #6) — the pass is bounded by
    // the caller's deadline: rows not reached count unexpected, so
    // `member_erased` is withheld and the next re-drive continues.
    it('deadline passed before the pass → no Resend call; every terminal row counts unexpected', async () => {
      const deps = makeDeps({ terminalRows: [terminalA, terminalB] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, {
        ...erasureInput,
        deadlineAt: new Date('2026-05-02T23:59:59Z'),
      });
      expect(result).toEqual(value({ unexpectedErrorCount: 2, deferredCount: 2 }));
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
      // Review round 2 (code-review #4) — a deferral is its own label, not the
      // stop-the-line `unexpected_error`; it still withholds member_erased.
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['deferred', 'deferred']);
    });

    it('deadline reached mid-pass → the rows before it settle, the rest count unexpected', async () => {
      const deps = makeDeps({ terminalRows: [terminalA, terminalB] }) as unknown as Seen & { clock: { now: () => Date } };
      let t = Date.parse('2026-05-03T00:00:00Z');
      deps.clock.now = () => {
        const at = new Date(t);
        t += 1_000;
        return at;
      };
      const result = await cancelInFlightBroadcastsForMember(deps as never, {
        ...erasureInput,
        // The cascade's own `now` read takes 00:00:00; row A is checked at
        // 00:00:01 (before the deadline), row B at 00:00:02 (not before it).
        deadlineAt: new Date('2026-05-03T00:00:02Z'),
      });
      expect(result).toEqual(value({ resendDraftsCleared: 1, unexpectedErrorCount: 1, deferredCount: 1 }));
      expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['terminal_draft_cleared', 'deferred']);
      expect(deps.broadcastsGateway.deleteBroadcastOnce).toHaveBeenCalledTimes(1);
    });

    it('a deadline still ahead changes nothing', async () => {
      const deps = makeDeps({ terminalRows: [terminalA] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, {
        ...erasureInput,
        deadlineAt: new Date('2026-05-04T00:00:00Z'),
      });
      expect(result).toEqual(value({ resendDraftsCleared: 1 }));
    });

    it.each(['draft', 'unknown', 'not_found', 'retryable', 'other', 'throws'] as const)(
      'DELETE answers forbidden but the GET says %s → unexpected (fail closed): member_erased is withheld, nothing counted',
      async (probe) => {
        const deps = makeDeps({ terminalRows: [terminalA], deleteOutcome: 'forbidden', probe }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual(value({ unexpectedErrorCount: 1 }));
        expect(deps.audit.emit).not.toHaveBeenCalled();
        expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
      },
    );

    it.each(['retryable', 'other', 'throws'] as const)(
      'DELETE answers %s → unexpected, no probe — the reconcile-erasures re-drive asks again',
      async (outcome) => {
        const deps = makeDeps({ terminalRows: [terminalA], deleteOutcomeById: { 'rb-term-a': outcome } }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual(value({ unexpectedErrorCount: 1 }));
        expect(deps.broadcastsGateway.retrieveBroadcastOnce).not.toHaveBeenCalled();
      },
    );

    it('ED3 — one unexpected row does not stop the next: the other row is still cleared, and the run reports both', async () => {
      const deps = makeDeps({
        terminalRows: [terminalA, terminalB],
        deleteOutcomeById: { 'rb-term-a': 'retryable', 'rb-term-b': 'deleted' },
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual(value({ unexpectedErrorCount: 1, resendDraftsCleared: 1 }));
      expect(deps.calls).toEqual(['delete:rb-term-a:no-lock', 'delete:rb-term-b:no-lock', 'evidence:count']);
    });

    it('ED3 — the re-drive after a retryable answer: the draft the first run could not delete now answers absent → cleared, nothing unexpected', async () => {
      const first = makeDeps({ terminalRows: [terminalA], deleteOutcomeById: { 'rb-term-a': 'retryable' } }) as unknown as Seen;
      expect(await cancelInFlightBroadcastsForMember(first as never, erasureInput)).toEqual(value({ unexpectedErrorCount: 1 }));
      const redrive = makeDeps({ terminalRows: [terminalA], deleteOutcome: 'absent' }) as unknown as Seen;
      expect(await cancelInFlightBroadcastsForMember(redrive as never, erasureInput)).toEqual(value({ resendDraftsCleared: 1 }));
    });

    it('the terminal list read fails → unexpected (member_erased withheld), never a whole-cascade server error', async () => {
      const deps = makeDeps({ inFlightRows: [{ broadcastId: broadcastIdB, status: 'submitted' }], terminalRows: 'throws' }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual(value({ cancelledCount: 1, unexpectedErrorCount: 1 }));
    });

    it('runs AFTER the in-flight pass (a row it has just cancelled is re-listed and counted), and BEFORE the already-sent count read', async () => {
      const deps = makeDeps({ inFlightRows: [{ broadcastId: broadcastIdB, status: 'submitted' }], terminalRows: [terminalA] }) as unknown as Seen;
      await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(deps.calls).toEqual([`lock:${broadcastIdB}`, `read:${broadcastIdB}`, `cas:${broadcastIdB}`, 'delete:rb-term-a:no-lock', 'evidence:count']);
    });

    it('the archive mode (skip) never lists terminal rows and never calls Resend', async () => {
      const deps = makeDeps({ terminalRows: [terminalA] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual(value({}));
      expect(deps.broadcastsRepo.listTerminalWithResendIdOwnedByMember).not.toHaveBeenCalled();
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
    });
  });
});
