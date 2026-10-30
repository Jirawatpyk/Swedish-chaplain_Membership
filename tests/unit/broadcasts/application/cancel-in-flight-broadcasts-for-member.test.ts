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
  /** Spec 139 — what `deleteBroadcastOnce` answers (erasure mode only). Default: `deleted`. */
  deleteOutcome?: 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other';
  /** Spec 139 P5 — what the probe after a 403 answers; `'throws'` = it fails. Default: `sent`. */
  probe?: 'draft' | 'queued' | 'sending' | 'sent' | 'cancelled' | 'unknown' | 'not_found' | 'throws';
  /** Spec 139 — the tenant already holds this broadcast's `already_sent` evidence row. Default: false. */
  alreadySentEvidence?: boolean;
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
    hasAlreadySentEvidenceInTx: vi.fn(async (_tx: unknown, _t: unknown, broadcastId: string) => {
      // Read on the emit's tx, or a concurrent re-drive could slip between them.
      calls.push(openTx > 0 ? `evidence:${broadcastId}` : `evidence:${broadcastId}:no-tx`);
      return overrides.alreadySentEvidence ?? false;
    }),
  };
  const audit = {
    emit: vi.fn(async () => {
      if (overrides.auditEmitImpl) {
        await overrides.auditEmitImpl();
      }
    }),
  };
  const clock = { now: () => new Date('2026-05-03T00:00:00Z') };
  // Spec 139 — the gateway the erasure mode calls under the row lock. Recorded
  // into `calls` so a test can prove the DELETE sits between the read and the CAS.
  const broadcastsGateway = {
    deleteBroadcastOnce: vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
      return { kind: overrides.deleteOutcome ?? 'deleted' };
    }),
    retrieveBroadcast: vi.fn(async (id: string) => {
      // The probe retries (`withRetry`, up to 31 s), so it must never run under the lock.
      calls.push(openTx > 0 ? `probe:${id}:under-lock` : `probe:${id}`);
      const probe = overrides.probe ?? 'sent';
      if (probe === 'throws') throw new Error('Resend 500 on GET /broadcasts');
      if (probe === 'not_found') return { kind: 'not_found' as const };
      return { kind: 'present' as const, resource: { id, status: probe, sentAt: null } };
    }),
  };
  return {
    broadcastsRepo,
    audit,
    clock,
    broadcastsGateway,
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0 } });
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
    expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0 } });
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
      expect(deps.calls).toContain(`cas:${broadcastIdA}`);
    });

    it('the row is gone under the lock → no transition; the re-read confirms it and it is a benign skip', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'submitted' }],
        lockedRowImpl: async () => null,
        findByIdImpl: async () => null,
      }) as { calls: string[] };
      const result = await cancelInFlightBroadcastsForMember(deps as never, { tenant, memberId, requestId: 'req-1' });
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 1, unexpectedErrorCount: 0, alreadySentCount: 0 } });
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

  /**
   * Spec 139 DE2 — the ERASURE mode (`onDispatchBegun: 'delete_then_cancel'`).
   *
   * Both legs persist `resend_broadcast_id` BEFORE `/send`, so an `approved`
   * row with an id may be a draft nobody has sent yet — and, on the import
   * leg, one minted from the PRE-scrub content. Skipping it (D1, kept for
   * archive above) let the dispatcher send an erased member's E-Blast. Under
   * the existing row lock the cascade now asks Resend to DELETE it, ONCE:
   *
   *   - 200 / 404 → cancelled in the same tx; `broadcast_cancelled` carries
   *     `resendOutcome` (`deleted` | `absent`);
   *   - 403 → probed (P5: a restricted key answers 403 too): `queued` /
   *     `sending` / `sent` → the row is left as it is and
   *     `broadcast_concurrent_action_blocked` (`dispatchBegun: true`,
   *     `resendOutcome: 'already_sent'`) is written on its own tx after the
   *     lock tx (P6) — once per broadcast: a re-erasure that finds the row
   *     already there writes no second one — and `alreadySentCount` + 1 on
   *     every run; any other probe answer → unexpected;
   *   - retryable / other → unexpected (row unchanged; the adapter reports
   *     `cascade_partial_failure`, `member_erased` is withheld, the
   *     `reconcile-erasures` cron drives it again).
   */
  describe('spec 139 DE2 — the erasure mode deletes the draft, then cancels, under the lock', () => {
    const erasureInput = { tenant, memberId, requestId: 'req-1', onDispatchBegun: 'delete_then_cancel' as const };
    const handedRow = (ids: Record<string, unknown> = {}) => async (id: string) =>
      id === broadcastIdA
        ? { broadcastId: id, status: 'approved', resendBroadcastId: 'rb-live-1', audienceImportId: null, ...ids }
        : { broadcastId: id, status: 'submitted', resendBroadcastId: null, audienceImportId: null };
    type Seen = {
      calls: string[];
      txOutcomes: string[];
      audit: { emit: ReturnType<typeof vi.fn> };
      broadcastsGateway: { deleteBroadcastOnce: ReturnType<typeof vi.fn>; retrieveBroadcast: ReturnType<typeof vi.fn> };
    };
    const eventsOf = (deps: Seen, eventType: string) =>
      deps.audit.emit.mock.calls.filter((c) => (c[1] as { eventType: string }).eventType === eventType);

    it.each(['deleted', 'absent'] as const)(
      'DELETE answers %s → the row is cancelled in the same tx, broadcast_cancelled carries resendOutcome',
      async (outcome) => {
        const deps = makeDeps({
          inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
          lockedRowImpl: handedRow(),
          deleteOutcome: outcome,
        }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
        // The DELETE sits between the locked read and the CAS — one tx.
        expect(deps.calls).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, 'delete:rb-live-1', `cas:${broadcastIdA}`]);
        expect(deps.broadcastsGateway.deleteBroadcastOnce).toHaveBeenCalledTimes(1);
        expect(deps.txOutcomes).toEqual(['committed']);
        const [cancelled] = eventsOf(deps, 'broadcast_cancelled');
        expect(cancelled?.[1]).toMatchObject({ payload: expect.objectContaining({ broadcastId: broadcastIdA, resendOutcome: outcome }) });
        expect(eventsOf(deps, 'broadcast_concurrent_action_blocked')).toEqual([]);
      },
    );

    it.each(['queued', 'sending', 'sent'] as const)(
      'DELETE answers 403 and the probe says %s → already sent: no transition, probed after the lock is released, the residual row on its own tx, alreadySentCount 1',
      async (status) => {
        const deps = makeDeps({
          inFlightRows: [
            { broadcastId: broadcastIdA, status: 'approved' },
            { broadcastId: broadcastIdB, status: 'submitted' },
          ],
          lockedRowImpl: handedRow(),
          deleteOutcome: 'forbidden',
          probe: status,
        }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 1 } });
        expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
        expect(deps.calls.slice(0, 4)).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, 'delete:rb-live-1', 'probe:rb-live-1']);
        // A's lock tx (nothing written), A's residual-row tx, B's cancel.
        expect(deps.txOutcomes).toEqual(['committed', 'committed', 'committed']);
        const blocked = eventsOf(deps, 'broadcast_concurrent_action_blocked');
        expect(blocked).toHaveLength(1);
        // P6 — durable: on the cascade's tx, never `emit(null)`.
        expect(blocked[0]![0]).not.toBeNull();
        expect(blocked[0]![1]).toMatchObject({
          payload: expect.objectContaining({ broadcastId: broadcastIdA, dispatchBegun: true, resendOutcome: 'already_sent', observedResendStatus: status }),
        });
      },
    );

    it.each(['draft', 'cancelled', 'unknown', 'not_found', 'throws'] as const)(
      'DELETE answers 403 but the probe says %s → unexpected (a restricted key, not a send): nothing written',
      async (probe) => {
        const deps = makeDeps({
          inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
          lockedRowImpl: handedRow(),
          deleteOutcome: 'forbidden',
          probe,
        }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
        expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
        // The lock tx wrote nothing and committed; the probe ran after it.
        expect(deps.txOutcomes).toEqual(['committed']);
        expect(deps.calls).toContain('probe:rb-live-1');
        expect(deps.audit.emit).not.toHaveBeenCalled();
        expect(cascadeOutcomeSpy.mock.calls.map((c) => c[1])).toEqual(['unexpected_error']);
      },
    );

    it.each(['retryable', 'other'] as const)(
      'DELETE answers %s (a timeout included) → unexpected: the row unchanged, nothing written — the reconciler drives it again',
      async (outcome) => {
        const deps = makeDeps({
          inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
          lockedRowImpl: handedRow(),
          deleteOutcome: outcome,
        }) as unknown as Seen;
        const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
        expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
        expect(deps.calls).not.toContain(`cas:${broadcastIdA}`);
        expect(deps.broadcastsGateway.retrieveBroadcast).not.toHaveBeenCalled();
        expect(deps.txOutcomes).toEqual(['rolled_back']);
        expect(deps.audit.emit).not.toHaveBeenCalled();
      },
    );

    it('a re-erasure (manual, or the reconcile-erasures re-drive) whose evidence row already exists writes no second one; alreadySentCount still counts the broadcast', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow(),
        deleteOutcome: 'forbidden',
        probe: 'sent',
        alreadySentEvidence: true,
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      // member_erased must still say this E-Blast went out.
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 1 } });
      expect(eventsOf(deps, 'broadcast_concurrent_action_blocked')).toEqual([]);
      expect(deps.audit.emit).not.toHaveBeenCalled();
      // The existence check runs on a tx of its own, after the probe.
      expect(deps.calls).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, 'delete:rb-live-1', 'probe:rb-live-1', `evidence:${broadcastIdA}`]);
      expect(deps.txOutcomes).toEqual(['committed', 'committed']);
    });

    it('403 + already sent, but the residual audit row cannot be written → unexpected (P6): the reconciler drives it again', async () => {
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
      expect(deps.txOutcomes).toEqual(['committed', 'rolled_back']);
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
      expect(result).toEqual({ ok: true, value: { cancelledCount: 0, skippedConcurrentCount: 0, unexpectedErrorCount: 1, alreadySentCount: 0 } });
      expect(deps.calls).toEqual([`lock:${broadcastIdA}`, `read:${broadcastIdA}`, 'delete:rb-live-1', `cas:${broadcastIdA}`]);
      expect(deps.txOutcomes).toEqual(['rolled_back']);
    });

    it('an EMPTY id is not an id → cancelled without any Resend call', async () => {
      const deps = makeDeps({
        inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }],
        lockedRowImpl: handedRow({ resendBroadcastId: '' }),
      }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
    });

    it('a row with no Resend id is cancelled exactly as before — no Resend call', async () => {
      const deps = makeDeps({ inFlightRows: [{ broadcastId: broadcastIdA, status: 'approved' }] }) as unknown as Seen;
      const result = await cancelInFlightBroadcastsForMember(deps as never, erasureInput);
      expect(result).toEqual({ ok: true, value: { cancelledCount: 1, skippedConcurrentCount: 0, unexpectedErrorCount: 0, alreadySentCount: 0 } });
      expect(deps.broadcastsGateway.deleteBroadcastOnce).not.toHaveBeenCalled();
    });
  });
});
