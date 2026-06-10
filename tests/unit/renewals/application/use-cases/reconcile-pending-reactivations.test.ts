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
