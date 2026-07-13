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
import { CycleTransitionConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import type {
  F5RefundBridge,
  GetRefundOutcomeResult,
  IssueRefundForInvoiceResult,
} from '@/modules/renewals/application/ports/f5-refund-bridge';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-07T00:00:00Z');
const INVOICE_UUID = '00000000-0000-0000-0000-0000000bbbb1';
const REJECT_ADMIN_ID = 'admin-reject-1';
const REJECT_REFUND_ID = 'rfnd_async_reject_1';

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
  /**
   * F8-RP follow-up — when true, stamp the async reject-with-refund marker
   * (rejectRefundInitiatedAt/rejectRefundId/rejectActorUserId) so the cycle
   * flows through the reconcile cron's marked-settlement branch instead of the
   * timeout/reminder branches.
   */
  marked?: boolean;
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
    ...(overrides.marked
      ? {
          rejectRefundInitiatedAt: new Date(
            NOW.getTime() - (overrides.daysPending - 1) * 86_400_000,
          ).toISOString(),
          rejectRefundId: REJECT_REFUND_ID,
          rejectActorUserId: REJECT_ADMIN_ID,
        }
      : {}),
  });
}

function fakeDeps(args: {
  cycles: RenewalCycle[];
  refundResult?: IssueRefundForInvoiceResult;
  refundImpl?: () => Promise<IssueRefundForInvoiceResult>;
  reReadCycle?: (cycle: RenewalCycle) => RenewalCycle | null;
  /**
   * 063 Step-3 race modelling: `processTimeout` calls `findByIdInTx`
   * TWICE — once in tx1 (validate-before-refund) and once in tx2
   * (re-confirm-before-transition). `reReadCycle` applies the SAME
   * transform to both, so it can only model the Step-1 race (admin won
   * BEFORE the refund). To exercise the Step-3 residual (refund issued
   * in tx1-pending window, THEN admin wins before tx2's lock) the test
   * needs the re-read to differ per call: PENDING the first time,
   * COMPLETED/CANCELLED the second. `findByIdInTxImpl` overrides the
   * default lookup entirely and receives the 0-based call index.
   */
  findByIdInTxImpl?: (
    callIndex: number,
    cycle: RenewalCycle,
  ) => RenewalCycle | null;
  emitImpl?: () => Promise<void>;
  emitInTxImpl?: () => Promise<void>;
  transitionImpl?: () => Promise<RenewalCycle>;
  /**
   * F8-RP follow-up — the F5 settlement lookup result for the marked
   * reject-with-refund branch. Defaults to `not_found` (never called on the
   * non-marked timeout/reminder paths).
   */
  getRefundOutcomeResult?: GetRefundOutcomeResult;
  getRefundOutcomeImpl?: () => Promise<GetRefundOutcomeResult>;
  /**
   * F8-RP-2 review (Finding 1) — override the guarded marker-CLEAR result on
   * the settled-`failed` branch. Set to a throwing impl to prove the FAILED
   * branch is per-cycle error-isolated (a persistent clear-tx throw must NOT
   * 500 the whole reconcile pass).
   */
  clearRejectRefundImpl?: () => Promise<boolean>;
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
  getRefundOutcomeMock: ReturnType<typeof vi.fn>;
  markRejectRefundMock: ReturnType<typeof vi.fn>;
  clearRejectRefundMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(async () => ({
    items: args.cycles,
    nextCursor: null,
  }));
  let findByIdInTxCallIndex = 0;
  const findByIdInTxMock = vi.fn(async (_tx: unknown, _t: string, cid: string) => {
    const found = args.cycles.find((c) => c.cycleId === cid);
    const callIndex = findByIdInTxCallIndex;
    findByIdInTxCallIndex += 1;
    if (args.findByIdInTxImpl && found) {
      return args.findByIdInTxImpl(callIndex, found);
    }
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
  const getRefundOutcomeMock = vi.fn(
    args.getRefundOutcomeImpl ??
      (async () =>
        args.getRefundOutcomeResult ?? { status: 'not_found' as const }),
  );
  // F8-RP follow-up — marker write/clear + escalation-task mocks. Defaults:
  // the guarded marker writes succeed (return true); the escalation task is
  // newly created. Threaded onto cyclesRepo / a new escalationTaskRepo dep.
  const markRejectRefundMock = vi.fn(async () => true);
  const clearRejectRefundMock = vi.fn(
    args.clearRejectRefundImpl ?? (async () => true),
  );
  const insertTaskMock = vi.fn(async () => ({
    created: true,
    row: { taskId: 'task-async-reject-1' },
  }));
  const f5Bridge: F5RefundBridge = {
    issueRefundForInvoice: refundMock as never,
    getRefundOutcomeForInvoice: getRefundOutcomeMock as never,
    // The reconcile cron never calls the in-flight-refund resolver (Finding 3
    // is the admin-reject path); stub it so the mock satisfies the port.
    findPendingRefundForInvoice: vi.fn(async () => ({ status: 'none' as const })),
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
      markRejectRefundInitiatedInTx: markRejectRefundMock,
      clearRejectRefundMarkerInTx: clearRejectRefundMock,
    } as unknown as ReconcilePendingReactivationsDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    } as unknown as ReconcilePendingReactivationsDeps['auditEmitter'],
    escalationTaskRepo: {
      insertIfAbsent: insertTaskMock,
    } as unknown as ReconcilePendingReactivationsDeps['escalationTaskRepo'],
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
    getRefundOutcomeMock,
    markRejectRefundMock,
    clearRejectRefundMock,
    insertTaskMock,
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
      // F8-RP REGRESSION: a genuine failure MUST NOT bump the new pending
      // counter — the two are distinct money outcomes.
      expect(r.value.timeoutRefundPending).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('F8-RP: refund_pending — cycle stays pending, counted as timeoutRefundPending (NOT a failure)', async () => {
    // The F5 bridge returned `refund_pending` (async Stripe refund created,
    // row `pending`, awaiting the `charge.refund.updated` webhook). The cron
    // MUST leave the cycle in `pending_admin_reactivation` and NOT transition
    // it, MUST NOT count it as a timeout or a refund failure, and MUST surface
    // it via the distinct informational `timeoutRefundPending` counter. The
    // next cron run self-heals once the webhook/sweep settles the refund
    // (bridge then returns `no_payment_found` → normal lapse transition).
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      refundResult: {
        status: 'refund_pending',
        refundId: 'rfnd-async-1',
        processorRefundId: 're_async_1',
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timeoutRefundPending).toBe(1);
      // Not a timeout (no transition), not a refund failure (nothing failed).
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutRefundOrphaned).toBe(0);
    }
    // Cycle stays pending — no transition, no timed_out audit.
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
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

  it('Round-2 (HIGH reject-marker race): Step-1 re-read observes an async reject-marker stamped AFTER the snapshot → admin_race_skipped, NO refund, NO lapse', async () => {
    // Round-2 review (HIGH). The cron lists an UNMARKED day-30 cycle (so
    // processCycle routes the STALE snapshot to processTimeout), but an admin
    // async-rejects it mid-pass: adminRejectReactivation stamps
    // rejectRefundInitiatedAt while status stays pending_admin_reactivation.
    // processTimeout's Step-1 re-read MUST observe the fresh marker and bail —
    // NOT lapse the cycle (which would drop the admin's reject intent, the
    // post_refund_review finance task, and stamp a cron-actor timeout audit
    // instead of the rejecting admin). Leaving the row pending+marked lets the
    // marked branch converge to `cancelled` next pass. Pre-fix the Step-1
    // re-read checked ONLY status, so the marker was ignored and the cycle was
    // lapsed (timed_out) instead of cancelled — permanently, with no self-heal.
    const snapshot = pendingCycle({ daysPending: 30, marked: false });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [snapshot],
      findByIdInTxImpl: (_callIndex, c) => ({
        ...c,
        rejectRefundInitiatedAt: new Date(
          NOW.getTime() - 86_400_000,
        ).toISOString(),
        rejectRefundId: REJECT_REFUND_ID,
        rejectActorUserId: REJECT_ADMIN_ID,
      }),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // Bailed at Step 1 — no Stripe refund, no lapse transition, no timed_out audit.
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
    }
  });

  it('Round-2 (HIGH reject-marker race): marker becomes visible only at the Step-3 re-read → admin_race_skipped, NO lapse', async () => {
    // Narrower window: Step-1 observed a clean pending cycle and proceeded; the
    // F5 refund returned no_payment_found (the admin's own reject-refund had
    // already settled the money), so refundIssued=false; THEN the marker
    // becomes visible at the Step-3 re-read. The timeout lapse MUST be skipped
    // so the marked branch — not the timeout path — owns convergence to
    // cancelled next pass.
    const snapshot = pendingCycle({ daysPending: 30, marked: false });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [snapshot],
      refundResult: { status: 'no_payment_found' as const },
      findByIdInTxImpl: (callIndex, c) =>
        callIndex === 0
          ? c
          : {
              ...c,
              rejectRefundInitiatedAt: new Date(
                NOW.getTime() - 86_400_000,
              ).toISOString(),
              rejectRefundId: REJECT_REFUND_ID,
              rejectActorUserId: REJECT_ADMIN_ID,
            },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // Step 2 ran (refund consulted) but returned no_payment_found; no lapse.
    expect(refundMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
    }
  });
});

describe('reconcilePendingReactivations (H1 reliability) — loop-level per-cycle backstop', () => {
  it('timeout Step-1 re-read THROWS persistently → isolated as cycleProcessingErrors, cron does NOT reject, a second healthy cycle still processes', async () => {
    // H1 reliability fix. `processTimeout` Step-1 (the validate-under-lock
    // re-read: `acquireCycleLockInTx` + `findByIdInTx`) opens an UNGUARDED
    // `runInTenant`. A persistent NON-conflict throw there (DB blip / RLS
    // regression / poison row) escaped `processTimeout` → the caller for-loop
    // (which had NO top-level per-cycle guard) → the route 500'd the WHOLE
    // reconcile pass, blocking every other marked/timeout/reminder cycle for
    // the tenant — the SAME self-DoS class the marked branch's own outer
    // try/catch already closes, but on the timeout branch's Step-1. The
    // loop-level backstop isolates ANY unclassified escaped throw to its one
    // cycle: counts it in the distinct, alertable `cycleProcessingErrors`
    // outcome, logs at ERROR (PCI-safe ids + error constructor name only), and
    // continues.
    //
    // A SECOND, otherwise-processable cycle (a day-23 reminder-due cycle) is
    // seeded AFTER the poison cycle to prove the loop keeps going past the
    // throw. (A day-23 reminder cycle never calls `findByIdInTx`, so ONLY the
    // poison timeout cycle reaches the Step-1 re-read.)
    const poisonCycle = pendingCycle({ daysPending: 31, cycleSuffix: 'ca01' });
    const secondCycle = pendingCycle({ daysPending: 23, cycleSuffix: 'ca02' });
    const { deps, refundMock, transitionMock, emitMock } = fakeDeps({
      cycles: [poisonCycle, secondCycle],
      findByIdInTxImpl: (_callIndex, cycle) => {
        if (cycle.cycleId === poisonCycle.cycleId) {
          throw new Error('renewal_cycles: connection reset mid-Step-1-reread');
        }
        return cycle;
      },
    });

    const r = await reconcilePendingReactivations(deps, baseInput);

    // (a) the cron does NOT reject (no 500) — the Result is still ok(...).
    expect(r.ok).toBe(true);
    if (r.ok) {
      // (b) the poison cycle is isolated into the distinct alertable counter,
      // NEVER a classified timeout outcome (the throw escaped Step-1 BEFORE
      // any per-branch classification could run).
      expect(r.value.cycleProcessingErrors).toBe(1);
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(0);
      // (c) the SECOND cycle is still processed in the same run (its T-7
      // reminder fires) — the poison cycle did not abort the batch.
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.cyclesProcessed).toBe(2);
    }
    // Step-1 threw BEFORE the refund, so no Stripe call + no transition ran
    // for the poison cycle.
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    // The reminder path's `emit` fires once for the second cycle — unaffected
    // by the poison cycle's failure.
    expect(emitMock).toHaveBeenCalledOnce();
  });

  it('a classified per-branch outcome is NEVER re-labelled by the backstop (refund_failed stays refund_failed, cycleProcessingErrors=0)', async () => {
    // Guard the "backstop must not mask/re-label a classified outcome"
    // invariant: a branch that RETURNS a classified outcome (here the timeout
    // branch's `refund_failed`, which returns — never throws) must land in its
    // own counter and leave `cycleProcessingErrors` at 0. The backstop fires
    // ONLY on genuine escaped throws.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps } = fakeDeps({
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
      expect(r.value.timeoutRefundFailures).toBe(1);
      expect(r.value.cycleProcessingErrors).toBe(0);
    }
  });
});

describe('reconcilePendingReactivations (063) — POST-refund Step-3 residual classification', () => {
  it('Step-3 admin-approve-AFTER-refund (tx2 re-read shows completed) → post_refund_admin_race, NOT timed_out', async () => {
    // MONEY-OBSERVABILITY regression guard (063 xhigh review): the Step-1
    // lock re-read finds the cycle STILL pending (admin had not yet won),
    // so the cron PROCEEDS to issue the refund. The admin then approves
    // in the window between the refund and tx2's lock. The tx2 re-read
    // now finds `completed` ≠ pending and short-circuits the transition.
    //
    // The accepted residual (per #6): the member is `completed` (admin
    // approved) BUT got their money back (cron already refunded). This is
    // a money-safety residual that SRE MUST be able to see. The OLD code
    // let the tx2 lambda `return;` fall through to `return 'timed_out'` →
    // the cron counted it as a benign timeout → INVISIBLE. The fix routes
    // it to a DISTINCT `post_refund_admin_race` outcome (NOT inflating
    // `timedOut`) + a dedicated counter + a forensic log.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      // tx1 (callIndex 0) → PENDING (refund proceeds);
      // tx2 (callIndex 1) → COMPLETED (admin won the Step-3 window).
      findByIdInTxImpl: (callIndex, c) =>
        callIndex === 0
          ? c
          : ({ ...c, status: 'completed' } as unknown as typeof c),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // The refund WAS issued (Step-1 saw pending) — this is the residual.
    expect(refundMock).toHaveBeenCalledOnce();
    // The transition was short-circuited (admin's completed wins tx2).
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      // MUST NOT inflate timedOut (the cron did NOT lapse this cycle).
      expect(r.value.timedOut).toBe(0);
      // MUST NOT inflate refund failures (the refund SUCCEEDED).
      expect(r.value.timeoutRefundFailures).toBe(0);
      // Pre-refund admin-race counter MUST stay 0 (this is the POST case).
      expect(r.value.timeoutAdminRaceSkipped).toBe(0);
      // The NEW residual counter is bumped.
      expect(r.value.timeoutRefundOrphaned).toBe(1);
    }
  });

  it('Step-3 transition CONFLICT after refund (CycleTransitionConflictError) → post_refund_admin_race, NOT timed_out', async () => {
    // tx2 re-read still shows pending (the conflicting tx had not yet
    // committed at re-read time) but the transitionStatus call loses the
    // optimistic-lock race and throws CycleTransitionConflictError. The
    // OLD code's catch did `return;` → fell through to 'timed_out'. The
    // refund already issued, so this is the SAME money residual as the
    // non-pending re-read and MUST be classified identically.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          cycle.cycleId,
          'pending_admin_reactivation',
          'completed',
        );
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).toHaveBeenCalledOnce();
    // Transition conflict → audit never emitted.
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutRefundOrphaned).toBe(1);
    }
  });

  it('Step-3 transition THROWS (non-conflict) after refund succeeded → transition_failed_post_refund, NOT refund_failed', async () => {
    // The outer-catch fires when tx2 throws a NON-conflict error (e.g. a
    // DB blip during the transition/audit) AFTER the refund already
    // succeeded. The OLD code returned 'refund_failed' → inflated
    // `timeoutRefundFailures` → mislabelled a SUCCEEDED refund as a refund
    // failure. The fix classifies it distinctly: money is durable, the
    // next cron run finds it already-refunded and self-heals.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new Error('audit_log: connection reset mid-tx');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // The refund SUCCEEDED — this is NOT a refund failure.
    expect(refundMock).toHaveBeenCalledOnce();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      // MUST NOT be counted as a refund failure (the refund succeeded).
      expect(r.value.timeoutRefundFailures).toBe(0);
      // Distinct counter for "refund OK, transition failed, will self-heal".
      expect(r.value.timeoutTransitionFailedPostRefund).toBe(1);
    }
  });
});

describe('reconcilePendingReactivations (063 follow-up) — NO-MONEY Step-3 classification', () => {
  // The prior 063 xhigh fix added `post_refund_admin_race` +
  // `transition_failed_post_refund`, but they fired UNCONDITIONALLY on the
  // tx2 race / outer-catch paths — NOT gated on whether a refund actually
  // moved (`refundIssued`). For a NO-MONEY cycle (no linked invoice → Step 2
  // skipped → `refundIssued=false`, OR a `no_payment_found` refund result →
  // `refundIssued=false`), the SAME tx2 paths set the "post_refund" / paging
  // outcomes even though no money moved — inflating `timeoutRefundOrphaned`
  // with phantom money windows AND firing the PAGING
  // `timeoutTransitionFailedPostRefund` metric for a no-money DB blip.
  //
  // The fix gates the OUTCOME on `refundIssued`:
  //   - tx2 admin-race / conflict, NO money → `admin_race_skipped`
  //     (the Step-1 informational semantic — admin/conflict won, nothing
  //     to reconcile).
  //   - outer-catch transition-fail, NO money → `transition_failed_no_refund`
  //     (a DISTINCT informational outcome — cycle stays pending, self-heals
  //     next run, no money at stake; NOT the paging post-refund metric).

  it('NO-invoice cycle, Step-3 admin-race (tx2 non-pending) → admin_race_skipped, NOT post_refund_admin_race', async () => {
    // linkedInvoiceId=null → Step 2 refund skipped → refundIssued=false.
    // tx1 (callIndex 0) sees pending (so the cron proceeds past Step 1);
    // tx2 (callIndex 1) sees completed (admin won the Step-3 window).
    // No money ever moved, so this is exactly the Step-1 `admin_race_skipped`
    // semantic — it MUST land on the informational admin-race counter, NOT
    // the money-orphan counter.
    const cycle = pendingCycle({ daysPending: 30, linkedInvoiceId: null });
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      findByIdInTxImpl: (callIndex, c) =>
        callIndex === 0
          ? c
          : ({ ...c, status: 'completed' } as unknown as typeof c),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // No linked invoice → the refund bridge was never reached.
    expect(refundMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      // Informational admin-race counter IS bumped (no money moved).
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
      // The money-orphan counter MUST stay 0 — no phantom money window.
      expect(r.value.timeoutRefundOrphaned).toBe(0);
    }
  });

  it('NO-invoice cycle, Step-3 transition CONFLICT → admin_race_skipped, NOT post_refund_admin_race', async () => {
    // tx2 re-read still pending, but transitionStatus throws a
    // CycleTransitionConflictError. No money moved (no invoice), so the
    // conflict is just "admin/conflict won, nothing to reconcile".
    const cycle = pendingCycle({ daysPending: 30, linkedInvoiceId: null });
    const { deps, refundMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          cycle.cycleId,
          'pending_admin_reactivation',
          'completed',
        );
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
      expect(r.value.timeoutRefundOrphaned).toBe(0);
    }
  });

  it('NO-invoice cycle, Step-3 transition THROWS (non-conflict) → transition_failed_no_refund, NOT the PAGING post_refund metric', async () => {
    // The outer-catch fires on a non-conflict tx2 throw. No money moved
    // (no invoice), so the cycle stays pending + self-heals next run — this
    // is an INFORMATIONAL no-money outcome, NOT the paging
    // `timeoutTransitionFailedPostRefund` metric (which exists to page
    // on-call when REFUNDED money is stuck on a pending cycle).
    const cycle = pendingCycle({ daysPending: 30, linkedInvoiceId: null });
    const { deps, refundMock } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new Error('audit_log: connection reset mid-tx');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      // The PAGING post-refund counter MUST stay 0 — no money is stuck.
      expect(r.value.timeoutTransitionFailedPostRefund).toBe(0);
      // The new informational no-money counter IS bumped.
      expect(r.value.timeoutTransitionFailedNoRefund).toBe(1);
    }
  });

  it('no_payment_found refund (linked invoice, no settled charge), Step-3 transition THROWS → transition_failed_no_refund', async () => {
    // linkedInvoiceId is non-null so Step 2 runs, but the F5 bridge returns
    // `no_payment_found` → refundIssued=false (nothing was clawed back).
    // A non-conflict tx2 throw must therefore be the no-money outcome, NOT
    // the paging post-refund metric.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock } = fakeDeps({
      cycles: [cycle],
      refundResult: { status: 'no_payment_found' },
      transitionImpl: async () => {
        throw new Error('audit_log: connection reset mid-tx');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    // The bridge WAS called (invoice is linked) but found no payment.
    expect(refundMock).toHaveBeenCalledOnce();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
      expect(r.value.timeoutTransitionFailedPostRefund).toBe(0);
      expect(r.value.timeoutTransitionFailedNoRefund).toBe(1);
    }
  });

  it('no_payment_found refund, Step-3 admin-race (tx2 non-pending) → admin_race_skipped', async () => {
    // no_payment_found → refundIssued=false; tx2 sees the cycle non-pending.
    // No money moved → informational admin-race, NOT the money-orphan counter.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, refundMock, transitionMock } = fakeDeps({
      cycles: [cycle],
      refundResult: { status: 'no_payment_found' },
      findByIdInTxImpl: (callIndex, c) =>
        callIndex === 0
          ? c
          : ({ ...c, status: 'completed' } as unknown as typeof c),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(refundMock).toHaveBeenCalledOnce();
    expect(transitionMock).not.toHaveBeenCalled();
    if (r.ok) {
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutAdminRaceSkipped).toBe(1);
      expect(r.value.timeoutRefundOrphaned).toBe(0);
    }
  });
});

describe('reconcilePendingReactivations (F8-RP) — async reject-with-refund settlement', () => {
  it('marked cycle, refund SETTLED (day 5, NOT timeout) → cancelled byte-identical to sync reject (audit + task + admin actor)', async () => {
    // A cycle an admin rejected-with-refund on day ~4 whose async refund has
    // now settled. daysPending=5 is FAR below the 30-day timeout — the marked
    // branch runs EVERY pass, so the cycle converges to `cancelled` NOW, not
    // after a 30-day wait. Terminal MUST mirror the sync reject exactly.
    const cycle = pendingCycle({ daysPending: 5, marked: true });
    const {
      deps,
      refundMock,
      transitionMock,
      emitInTxMock,
      getRefundOutcomeMock,
      insertTaskMock,
    } = fakeDeps({
      cycles: [cycle],
      getRefundOutcomeResult: {
        status: 'succeeded',
        creditNoteId: 'cn-settled-async-1',
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectSettledCancelled).toBe(1);
      // NOT a timeout — the marked branch never reaches processTimeout.
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
    }
    // The settlement lookup (NOT a second issueRefund) drove the decision.
    expect(getRefundOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ refundId: REJECT_REFUND_ID }),
    );
    expect(refundMock).not.toHaveBeenCalled();
    // Transition byte-identical to the sync reject terminal.
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'pending_admin_reactivation',
      to: 'cancelled',
      closedReason: 'admin_rejected_with_refund',
      closedAt: NOW.toISOString(),
    });
    // `lapsed_member_admin_reactivation_rejected` audit with the settled CN id
    // AND the REPLAYED admin actor (NOT the cron).
    const rejectedEmit = emitInTxMock.mock.calls.find(
      (c) => c[1]?.type === 'lapsed_member_admin_reactivation_rejected',
    );
    expect(rejectedEmit).toBeTruthy();
    expect(rejectedEmit?.[1].payload).toMatchObject({
      actor_user_id: REJECT_ADMIN_ID,
      refund_credit_note_id: 'cn-settled-async-1',
    });
    expect(rejectedEmit?.[2]).toMatchObject({
      actorUserId: REJECT_ADMIN_ID,
      actorRole: 'admin',
    });
    // post_refund_review escalation task inserted (finance parity).
    expect(insertTaskMock).toHaveBeenCalledOnce();
    expect(insertTaskMock.mock.calls[0]?.[1]).toMatchObject({
      taskType: 'post_refund_review',
    });
  });

  it('marked cycle, refund STILL pending → skip (stays pending, no transition), still_pending counter', async () => {
    const cycle = pendingCycle({ daysPending: 5, marked: true });
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      getRefundOutcomeResult: { status: 'pending' },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectRefundStillPending).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('marked cycle, refund SETTLED FAILED → clears marker + alerting counter, NEVER cancelled, NEVER lapsed', async () => {
    // The admin rejected-with-refund but the async refund settled failed — the
    // money never returned. The cycle must NOT converge to cancelled and must
    // NOT lapse; the cron clears the marker (reverting to an ordinary pending
    // cycle) + fires the alerting outcome.
    const cycle = pendingCycle({ daysPending: 5, marked: true });
    const { deps, transitionMock, emitInTxMock, clearRejectRefundMock } =
      fakeDeps({
        cycles: [cycle],
        getRefundOutcomeResult: {
          status: 'failed',
          failureReasonCode: 'stripe_refund_failed',
        },
      });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectRefundFailed).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
      expect(r.value.timedOut).toBe(0);
    }
    expect(clearRejectRefundMock).toHaveBeenCalledOnce();
    // Finding 5: the clear is GUARDED on the SAME refund id this branch resolved
    // (the marker's R1, `REJECT_REFUND_ID`) so a concurrent re-reject that
    // overwrote the marker with a fresh R2 in the read→clear window is a no-op
    // rather than clobbering R2's live marker. Signature:
    // (tx, tenantId, cycleId, refundId).
    expect(clearRejectRefundMock.mock.calls[0]?.[3]).toBe(REJECT_REFUND_ID);
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('Finding 1 (per-cycle isolation): marked FAILED-branch marker-clear tx THROWS (non-conflict) → settle_failed, cron does NOT reject, next cycle still processed', async () => {
    // Sibling of the succeeded-settle THROW test above, for the settled-FAILED
    // branch. BEFORE this fix that branch cleared the marker inside a BARE
    // `runInTenant` with NO try/catch — a persistent throw from
    // `acquireCycleLockInTx` / `clearRejectRefundMarkerInTx` escaped
    // `processMarkedRejectRefund`, propagated through the caller's unguarded
    // for-loop, and 500'd the WHOLE reconcile pass (self-DoS), blocking every
    // other marked/timeout/reminder cycle for the tenant. A SECOND,
    // otherwise-processable cycle (a day-23 reminder-due cycle) is seeded AFTER
    // the poison cycle to prove the loop keeps going past the throw.
    const poisonCycle = pendingCycle({
      daysPending: 5,
      marked: true,
      cycleSuffix: 'c093',
    });
    const secondCycle = pendingCycle({ daysPending: 23, cycleSuffix: 'c094' });
    const { deps, transitionMock, emitMock, clearRejectRefundMock } = fakeDeps({
      cycles: [poisonCycle, secondCycle],
      getRefundOutcomeResult: {
        status: 'failed',
        failureReasonCode: 'stripe_refund_failed',
      },
      clearRejectRefundImpl: async () => {
        throw new Error('renewal_cycles: connection reset mid-clear-tx');
      },
    });

    const r = await reconcilePendingReactivations(deps, baseInput);

    // (a) the cron does NOT reject (no 500) — the Result is still ok(...).
    expect(r.ok).toBe(true);
    if (r.ok) {
      // (c) the failing cycle is classified `settle_failed` (self-heals next
      // pass, same discipline as the succeeded-settle blip), NEVER
      // `refund_failed` (which would imply the marker was cleared + the cycle
      // reverted) and never a settled/lapse counter.
      expect(r.value.asyncRejectSettleFailed).toBe(1);
      expect(r.value.asyncRejectRefundFailed).toBe(0);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
      expect(r.value.timedOut).toBe(0);
      // (b) the SECOND cycle is still processed in the same run (its T-7
      // reminder fires) — the poison cycle did not abort the batch.
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.cyclesProcessed).toBe(2);
    }
    // The clear was attempted (and threw); the succeeded-path transition never runs.
    expect(clearRejectRefundMock).toHaveBeenCalledOnce();
    expect(transitionMock).not.toHaveBeenCalled();
    // The reminder path's `emit` (distinct from the marked-branch writes) fires
    // once for the second cycle — unaffected by the poison cycle's failure.
    expect(emitMock).toHaveBeenCalledOnce();
  });

  it('marked cycle, F5 settlement lookup FAILED → lookup_failed counter, cycle untouched (retry next pass)', async () => {
    const cycle = pendingCycle({ daysPending: 5, marked: true });
    const { deps, transitionMock, clearRejectRefundMock } = fakeDeps({
      cycles: [cycle],
      getRefundOutcomeResult: {
        status: 'lookup_failed',
        detail: 'repo_unavailable',
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.asyncRejectLookupFailed).toBe(1);
    expect(transitionMock).not.toHaveBeenCalled();
    // Marker is NOT cleared on a transient lookup failure — retry next pass.
    expect(clearRejectRefundMock).not.toHaveBeenCalled();
  });

  it('marked cycle, refund settled but admin won the tx re-read race → admin_race_skipped, no transition', async () => {
    // The settle lookup returns succeeded, but the tx-bound re-read under the
    // lock finds the cycle no longer pending (a concurrent admin approve won
    // between list + lock). The cron must NOT write the cancel transition.
    const cycle = pendingCycle({ daysPending: 5, marked: true });
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      getRefundOutcomeResult: {
        status: 'succeeded',
        creditNoteId: 'cn-race-1',
      },
      reReadCycle: () =>
        ({ ...cycle, status: 'completed' } as unknown as typeof cycle),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectAdminRaceSkipped).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('F8-RP-2 review fix: marked cycle settle-tx THROWS a non-conflict error (emitInTx blip) → settle_failed, cron does NOT reject, next cycle still processed', async () => {
    // Resilience regression guard (F8-RP-2 review). BEFORE this fix, the
    // succeeded-settle tx only caught `CycleTransitionConflictError` /
    // `CycleNotFoundError` — a NON-conflict throw from `emitInTx` (or
    // `escalationTaskRepo.insertIfAbsent` / the 2nd `emitInTx`) escaped
    // `processMarkedRejectRefund` uncaught, propagated through the caller's
    // for-loop (which has no try/catch of its own — same shape as
    // `processTimeout`'s caller), and rejected the WHOLE
    // `reconcilePendingReactivations` call. A single poison marked cycle
    // could 500 the entire cron pass, blocking every other marked/timeout/
    // reminder cycle for the tenant in the same run — a self-DoS. A SECOND,
    // otherwise-processable cycle (a day-23 reminder-due cycle) is seeded
    // AFTER the poison cycle to prove the loop keeps going past the throw.
    const poisonCycle = pendingCycle({
      daysPending: 5,
      marked: true,
      cycleSuffix: 'c091',
    });
    const secondCycle = pendingCycle({ daysPending: 23, cycleSuffix: 'c092' });
    const { deps, transitionMock, emitInTxMock, emitMock } = fakeDeps({
      cycles: [poisonCycle, secondCycle],
      getRefundOutcomeResult: {
        status: 'succeeded',
        creditNoteId: 'cn-throw-1',
      },
      emitInTxImpl: async () => {
        throw new Error('audit_log: connection reset mid-tx');
      },
    });

    const r = await reconcilePendingReactivations(deps, baseInput);

    // (a) the cron does NOT reject (no 500) — the Result is still ok(...).
    expect(r.ok).toBe(true);
    if (r.ok) {
      // (c) the failing cycle is classified `settle_failed`, NEVER
      // `settled_cancelled` (which would imply the cycle was cancelled) and
      // never a timeout/lapse counter — it stays marked + pending for the
      // next cron pass to retry (the tx that would have written `cancelled`
      // rolled back on the throw; nothing here landed a partial write).
      expect(r.value.asyncRejectSettleFailed).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
      expect(r.value.timedOut).toBe(0);
      // (b) the SECOND cycle is still processed in the same run (its T-7
      // reminder fires) — the poison cycle did not abort the batch.
      expect(r.value.remindersT7).toBe(1);
      expect(r.value.cyclesProcessed).toBe(2);
    }
    // The transition was attempted (it runs before the emitInTx throw inside
    // the same tx) — only the poison cycle reaches it (the second cycle is
    // below the 30-day timeout threshold, so it never calls transitionStatus).
    expect(transitionMock).toHaveBeenCalledOnce();
    expect(emitInTxMock).toHaveBeenCalledOnce();
    // The reminder path's `emit` (distinct from `emitInTx`) is unaffected by
    // the poison cycle's failure.
    expect(emitMock).toHaveBeenCalledOnce();
  });

  it('marked cycle PAST timeout (day 35) with pending refund → stays pending, does NOT lapse (marker shields from timeout)', async () => {
    // REGRESSION guard for the divergence invariant: a marked reject cycle
    // whose refund is still settling at day 35 must NOT time out to `lapsed`
    // — its intended terminal is `cancelled`. The marked branch takes it
    // BEFORE processTimeout can lapse it.
    const cycle = pendingCycle({ daysPending: 35, marked: true });
    const { deps, transitionMock } = fakeDeps({
      cycles: [cycle],
      getRefundOutcomeResult: { status: 'pending' },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.asyncRejectRefundStillPending).toBe(1);
      // MUST NOT lapse — the marker shields it from the timeout branch.
      expect(r.value.timedOut).toBe(0);
      expect(r.value.timeoutRefundFailures).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('REGRESSION: UNMARKED genuine timeout (day 30) still → lapsed, async counters all 0', async () => {
    // The terminal-state divergence: an UNMARKED pending cycle with no admin
    // action still lapses at 30 days. It MUST NOT be pulled into the marked
    // branch (no marker) and MUST NOT reach `cancelled`.
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, transitionMock, getRefundOutcomeMock } = fakeDeps({
      cycles: [cycle],
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.timedOut).toBe(1);
      expect(r.value.asyncRejectSettledCancelled).toBe(0);
      expect(r.value.asyncRejectRefundStillPending).toBe(0);
      expect(r.value.asyncRejectRefundFailed).toBe(0);
    }
    // The settlement lookup is never consulted for an unmarked cycle.
    expect(getRefundOutcomeMock).not.toHaveBeenCalled();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      to: 'lapsed',
      closedReason: 'pending_reactivation_timed_out',
    });
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
