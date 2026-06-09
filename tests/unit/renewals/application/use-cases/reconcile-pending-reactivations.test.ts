/**
 * F8 Phase 5 Wave B · T138 spec — `reconcilePendingReactivations`.
 *
 * Cron use-case walking pending cycles + emitting reminder ladder
 * audits + auto-timing-out at 30 days.
 */
import { describe, expect, it, vi } from 'vitest';
import { reconcilePendingReactivations } from '@/modules/renewals/application/use-cases/reconcile-pending-reactivations';
import type { ReconcilePendingReactivationsDeps } from '@/modules/renewals/application/use-cases/reconcile-pending-reactivations';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  F5RefundBridge,
  IssueRefundForInvoiceResult,
} from '@/modules/renewals/application/ports/f5-refund-bridge';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-07T00:00:00Z');
const INVOICE_UUID = '00000000-0000-0000-0000-0000000bbbb1';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix collection error.
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function pendingCycle(overrides: {
  cycleSuffix?: string;
  daysPending: number;
  linkedInvoiceId?: string | null;
}): RenewalCycle {
  const cycleSuffix = overrides.cycleSuffix ?? 'c001';
  const enteredAt = new Date(
    NOW.getTime() - overrides.daysPending * 86_400_000,
  ).toISOString();
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(`00000000-0000-0000-0000-00000000${cycleSuffix}`),
    status: 'pending_admin_reactivation',
    enteredPendingAt: enteredAt,
    linkedInvoiceId:
      overrides.linkedInvoiceId === undefined
        ? INVOICE_UUID
        : overrides.linkedInvoiceId,
  });
}

function fakeDeps(args: {
  cycles: RenewalCycle[];
  refundResult?: IssueRefundForInvoiceResult;
  refundImpl?: () => Promise<IssueRefundForInvoiceResult>;
  reReadCycle?: (cycle: RenewalCycle) => RenewalCycle | null;
  emitImpl?: () => Promise<void>;
  emitInTxImpl?: () => Promise<void>;
  transitionImpl?: () => Promise<RenewalCycle>;
  /**
   * T138 catch-up review-fix: per-cycleId mapping of which reminder
   * audits already exist. Defaults to empty (cron-skip never happened
   * before — fire all crossed thresholds). Set to a populated set to
   * simulate "T-7 already fired" so the cron does NOT double-fire.
   */
  alreadyEmittedByCycle?: Map<string, ReadonlySet<string>>;
  reminderAuditQueryImpl?: (
    tenantId: string,
    cycleId: string,
  ) => Promise<ReadonlySet<string>>;
}): {
  deps: ReconcilePendingReactivationsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  refundMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  reminderAuditQueryMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(async () => ({
    items: args.cycles,
    nextCursor: null,
  }));
  const findByIdInTxMock = vi.fn(async (_tx: unknown, _t: string, cid: string) => {
    const found = args.cycles.find((c) => c.cycleId === cid);
    return args.reReadCycle && found ? args.reReadCycle(found) : found ?? null;
  });
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async (_tx: unknown, _t: string, cid: string) => {
        const found = args.cycles.find((c) => c.cycleId === cid);
        return { ...found!, status: 'cancelled' as const };
      }),
  );
  const acquireLockMock = vi.fn(async () => {});
  const refundMock = vi.fn(
    args.refundImpl ??
      (async () =>
        args.refundResult ?? {
          status: 'refunded' as const,
          refundId: 'rfnd-1',
          creditNoteId: 'cn-1',
          creditNoteNumber: 'CN-1',
        }),
  );
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  const f5Bridge: F5RefundBridge = {
    issueRefundForInvoice: refundMock as never,
  };
  const reminderAuditQueryMock = vi.fn(
    args.reminderAuditQueryImpl ??
      (async (_tenantId: string, cycleId: string) =>
        args.alreadyEmittedByCycle?.get(cycleId) ?? new Set<string>()),
  );
  const deps: ReconcilePendingReactivationsDeps = {
    tenant: { slug: TENANT_ID } as ReconcilePendingReactivationsDeps['tenant'],
    cyclesRepo: {
      list: listMock,
      findByIdInTx: findByIdInTxMock,
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
    } as unknown as ReconcilePendingReactivationsDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    } as unknown as ReconcilePendingReactivationsDeps['auditEmitter'],
    f5RefundBridge: f5Bridge,
    reminderAuditQuery: {
      findReminderAuditsForCycle:
        reminderAuditQueryMock as unknown as ReconcilePendingReactivationsDeps['reminderAuditQuery']['findReminderAuditsForCycle'],
    },
  };
  return {
    deps,
    emitMock,
    emitInTxMock,
    refundMock,
    transitionMock,
    reminderAuditQueryMock,
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  now: NOW,
  correlationId: 'corr-cron-1',
};

describe('reconcilePendingReactivations (T138) — reminder ladder', () => {
  it('day 23 fresh: emits only T-7 (no audits exist yet)', async () => {
    const cycle = pendingCycle({ daysPending: 23 });
    const { deps, emitMock, refundMock } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-7',
    });
    if (r.ok) expect(r.value.remindersT7).toBe(1);
  });

  it('day 27 with T-7 already emitted: emits only T-3', async () => {
    const cycle = pendingCycle({ daysPending: 27 });
    const { deps, emitMock } = fakeDeps({
      cycles: [cycle],
      alreadyEmittedByCycle: new Map([
        [cycle.cycleId, new Set(['lapsed_member_admin_reactivation_reminder_t-7'])],
      ]),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-3',
    });
    if (r.ok) expect(r.value.remindersT3).toBe(1);
  });

  it('day 29 with T-7 + T-3 already emitted: emits only T-1', async () => {
    const cycle = pendingCycle({ daysPending: 29 });
    const { deps, emitMock } = fakeDeps({
      cycles: [cycle],
      alreadyEmittedByCycle: new Map([
        [
          cycle.cycleId,
          new Set([
            'lapsed_member_admin_reactivation_reminder_t-7',
            'lapsed_member_admin_reactivation_reminder_t-3',
          ]),
        ],
      ]),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-1',
    });
    if (r.ok) expect(r.value.remindersT1).toBe(1);
  });

  it('day 22 — no audit (T-7 threshold not yet crossed)', async () => {
    const cycle = pendingCycle({ daysPending: 22 });
    const { deps, emitMock } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('idempotent: day 24 with T-7 already emitted — no audit', async () => {
    const cycle = pendingCycle({ daysPending: 24 });
    const { deps, emitMock } = fakeDeps({
      cycles: [cycle],
      alreadyEmittedByCycle: new Map([
        [cycle.cycleId, new Set(['lapsed_member_admin_reactivation_reminder_t-7'])],
      ]),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('T138 catch-up: day 25 with NO T-7 audit fires T-7 (cron-skip recovery)', async () => {
    // The previous equality-only logic would silently skip this — the
    // cron only fired on day === 23. Now the audit-existence guard
    // closes the gap: day 25 sees no T-7 row and emits the reminder.
    const cycle = pendingCycle({ daysPending: 25 });
    const { deps, emitMock } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-7',
    });
    if (r.ok) {
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.remindersT3).toBe(0);
    }
  });

  it('T138 catch-up: day 28 with NO audits fires BOTH T-7 + T-3 (double cron-skip)', async () => {
    // Cron skipped both day 23 + day 27. Day 28 invocation catches up
    // by firing both rungs whose threshold is crossed and whose audit
    // is missing — order is T-7 first, T-3 second.
    const cycle = pendingCycle({ daysPending: 28 });
    const { deps, emitMock } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-7',
    });
    expect(emitMock.mock.calls[1]?.[0]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_reminder_t-3',
    });
    if (r.ok) {
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.remindersT3).toBe(1);
      expect(r.value.remindersT1).toBe(0);
    }
  });

  it('reminderAuditQuery failure falls back to fire-anyway (degraded mode never blocks the cron)', async () => {
    const cycle = pendingCycle({ daysPending: 23 });
    const { deps, emitMock } = fakeDeps({
      cycles: [cycle],
      reminderAuditQueryImpl: async () => {
        throw new Error('audit_log: connection lost');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // Round 2 review-fix (S-5): tighten the assertion. With
    // daysPending=23 only the T-7 threshold has been crossed; the
    // empty fallback set means we re-fire every CROSSED rung — i.e.
    // exactly T-7, NOT T-3 (threshold 27) and NOT T-1 (threshold 29).
    // Round 1 only asserted "emitMock was called" — a bug that emits
    // ALL three rungs on day-23 fallback (e.g. someone refactors
    // decideRemindersToFire to drop the daysPending check) would
    // have slipped through. Now locked.
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lapsed_member_admin_reactivation_reminder_t-7',
      }),
      expect.anything(),
    );
    if (r.ok) {
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.remindersT3).toBe(0);
      expect(r.value.remindersT1).toBe(0);
      expect(r.value.remindersFailed).toBe(0);
    }
  });
});

describe('reconcilePendingReactivations (T138) — auto-timeout', () => {
  it('day 30 — refunds + lapses cycle (cron-timeout) + emits timed_out audit', async () => {
    // I2 review-fix: the cron auto-timeout writes
    // `closedReason='pending_reactivation_timed_out'` (not the
    // ambiguous `'admin_rejected_with_refund'` it previously inherited
    // from the admin-reject path). Cycle moves to `'lapsed'` so the
    // lapsed-tab badge maps to the dedicated "Reactivation timed out"
    // label, distinguishing system-timeouts from explicit admin-rejects.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timedOut).toBe(1);
    expect(refundMock).toHaveBeenCalledOnce();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'pending_admin_reactivation',
      to: 'lapsed',
      closedReason: 'pending_reactivation_timed_out',
      // Round-5 review-finding L2: pin closedAt against the injected
      // `input.now` clock so a future regression that re-introduces
      // `new Date()` mid-tx (the WRN-12 anti-pattern) fails this
      // assertion. R4-W1 added `now: Date` to the input schema; this
      // line locks the pinning at the use-case level.
      closedAt: NOW.toISOString(),
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_timed_out',
    });
  });

  it('day 35 — also times out (boundary is >= 30)', async () => {
    const cycle = pendingCycle({ daysPending: 35 });
    const { deps } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timedOut).toBe(1);
  });

  it('day 30 with no linked invoice — skips refund call but cancels cycle', async () => {
    const cycle = pendingCycle({ daysPending: 30, linkedInvoiceId: null });
    const { deps, refundMock, transitionMock } = fakeDeps({ cycles: [cycle] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timedOut).toBe(1);
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).toHaveBeenCalledOnce();
  });

  it('refund_failed — counts as timeoutRefundFailures, no cycle transition', async () => {
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, transitionMock } = fakeDeps({
      cycles: [cycle],
      refundResult: {
        status: 'refund_failed',
        errorCode: 'processor_unavailable',
        detail: 'Stripe 503',
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(1);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('admin-approve-before-lock — re-confirm UNDER lock shows completed → NO refund, no transition (money safety)', async () => {
    // MONEY-SAFETY regression guard (063 audit): the timeout-refund must
    // happen ONLY after the per-cycle advisory lock + tx-bound re-read
    // re-confirm the cycle is STILL `pending_admin_reactivation`. If an
    // admin approved the reactivation in the race window (cycle now
    // `completed` — the member paid + got reactivated), the cron MUST
    // NOT claw back their money. The previous ordering issued the Stripe
    // refund BEFORE acquiring the lock, so an admin-approve that landed
    // first still got refunded. Now the validate-under-lock step gates
    // the refund: a non-pending re-read short-circuits to a no-op.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () =>
        ({ ...cycle, status: 'completed' } as unknown as typeof cycle),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // INVARIANT: an admin approval that lands before the lock prevents
    // the refund entirely.
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    // Not counted as a timeout — the admin's approval won, no money moved.
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
    }
  });

  it('admin-reject-before-lock — re-confirm shows cancelled → NO refund (no double-refund)', async () => {
    // Same guard for the admin-REJECT race: the admin-reject path already
    // issued the refund. The cron must not issue a SECOND refund. The
    // validate-under-lock re-read sees `cancelled` ≠ pending and skips.
    const cycle = pendingCycle({ daysPending: 31 });
    const { deps, refundMock, transitionMock } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () =>
        ({ ...cycle, status: 'cancelled' } as unknown as typeof cycle),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
    }
  });
});

describe('reconcilePendingReactivations (T138) — input validation + summary', () => {
  it('returns zero counters when no cycles pending', async () => {
    const { deps } = fakeDeps({ cycles: [] });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(0);
      expect(r.value.timedOut).toBe(0);
      expect(r.value.remindersT7).toBe(0);
    }
  });

  it('mixed cycles steady-state — counts each branch independently with prior audits seeded', async () => {
    // T138 catch-up review-fix: this test simulates the steady-state
    // daily cron where prior days have already seeded the audit rows.
    // Day 27 cycle has T-7 pre-emitted (from day 23 yesterday); day 29
    // has T-7 + T-3 pre-emitted; day 30 just times out. Without the
    // pre-emit map, the catch-up logic would correctly catch all the
    // missed rungs — that's covered by the cron-skip recovery test.
    const cycles = [
      pendingCycle({ daysPending: 23, cycleSuffix: 'c071' }),
      pendingCycle({ daysPending: 27, cycleSuffix: 'c072' }),
      pendingCycle({ daysPending: 29, cycleSuffix: 'c073' }),
      pendingCycle({ daysPending: 30, cycleSuffix: 'c074' }),
      pendingCycle({ daysPending: 10, cycleSuffix: 'c075' }), // no-op
    ];
    const alreadyEmittedByCycle = new Map<string, ReadonlySet<string>>([
      [
        cycles[1]!.cycleId,
        new Set(['lapsed_member_admin_reactivation_reminder_t-7']),
      ],
      [
        cycles[2]!.cycleId,
        new Set([
          'lapsed_member_admin_reactivation_reminder_t-7',
          'lapsed_member_admin_reactivation_reminder_t-3',
        ]),
      ],
    ]);
    const { deps } = fakeDeps({ cycles, alreadyEmittedByCycle });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(5);
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.remindersT3).toBe(1);
      expect(r.value.remindersT1).toBe(1);
      expect(r.value.timedOut).toBe(1);
    }
  });

  it('Round 2 review-fix (I-6): audit emit failure increments remindersFailed (NOT remindersT7), cron continues', async () => {
    // Round 1 swallowed emit failures into a `logger.warn` AND
    // incremented `remindersT7` regardless — the cron's own log line
    // ("I sent 47 reminders") would be a lie when 47 emits all threw.
    // Round 2 review fix: success counters only bump on emit-success;
    // a NEW `remindersFailed` counter (parity with
    // `timeoutRefundFailures`) tracks the misses for SRE alerting.
    const cycle = pendingCycle({ daysPending: 23 });
    const { deps } = fakeDeps({
      cycles: [cycle],
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Cron must not abort — output struct is still ok(...).
      // emit failed → remindersT7 NOT bumped.
      expect(r.value.remindersT7).toBe(0);
      // emit failed → remindersFailed bumped.
      expect(r.value.remindersFailed).toBe(1);
      // Cycle was processed (we didn't skip it).
      expect(r.value.cyclesProcessed).toBe(1);
    }
  });
});
