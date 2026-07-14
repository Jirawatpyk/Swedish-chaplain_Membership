/**
 * F8 Phase 5 Wave A.5 · T137 spec — `adminRejectReactivation`.
 *
 * Critical-path coverage: state validation, F5 refund bridge, atomic
 * tx for cycle transition + audit, post-refund reconciliation edge.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { adminRejectReactivation } from '@/modules/renewals/application/use-cases/admin-reject-reactivation';
import type { AdminRejectReactivationDeps } from '@/modules/renewals/application/use-cases/admin-reject-reactivation';
import { CycleTransitionConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  F5RefundBridge,
  FindPendingRefundForInvoiceResult,
  IssueRefundForInvoiceResult,
} from '@/modules/renewals/application/ports/f5-refund-bridge';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1d37';
const INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaa1';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix collection error from
  // F8/infra adapter import chain ("No 'db' export defined on mock").
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

// 070 speckit-review I2/I3 — capture `logger.error` so the reverse-direction
// (Principle VIII) rollback tests can assert the orphan-refund reconciliation
// log fired (refundIssuedRequiresReconciliation: true + refundCreditNoteId).
const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  // Dynamic import (not a static top-level import) — sidesteps hoisting/
  // TDZ ordering entirely, so this is safe regardless of where `@/lib/logger`
  // first gets pulled in relative to this file's other static imports.
  const { createMockLogger } = await import('../../../../helpers/mock-logger');
  return {
    ...actual,
    logger: createMockLogger({ error: loggerErrorMock, warn: vi.fn() }),
  };
});

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    status: 'pending_admin_reactivation',
    enteredPendingAt: '2026-04-01T00:00:00Z',
    linkedInvoiceId: INVOICE_UUID,
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  refundResult?: IssueRefundForInvoiceResult;
  refundImpl?: () => Promise<IssueRefundForInvoiceResult>;
  transitionImpl?: () => Promise<RenewalCycle>;
  emitImpl?: () => Promise<void>;
  /** F8-RP follow-up — override the guarded marker-write result (default true). */
  markRejectRefundResult?: boolean;
  /**
   * F8-RP-2 review (Finding 3) — override the in-flight-refund resolution the
   * reject use-case runs on the `refund_in_progress` path. Default `none` (no
   * resolvable pending refund → no stamp, the pre-fix behaviour).
   */
  findPendingRefundResult?: FindPendingRefundForInvoiceResult;
}): {
  deps: AdminRejectReactivationDeps;
  refundMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
  markRejectRefundMock: ReturnType<typeof vi.fn>;
  findPendingRefundMock: ReturnType<typeof vi.fn>;
} {
  const findByIdInTxMock = vi.fn(async () => args.cycle ?? null);
  const refundMock = vi.fn(
    args.refundImpl ??
      (async () =>
        args.refundResult ?? {
          status: 'refunded' as const,
          refundId: 'rfnd-1',
          creditNoteId: 'cn-1',
          creditNoteNumber: 'CN-2026-0001',
        }),
  );
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async () => ({ ...args.cycle!, status: 'cancelled' as const })),
  );
  const acquireLockMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(args.emitImpl ?? (async () => {}));
  // F8-RP follow-up — the guarded marker write on the async `refund_pending`
  // short-circuit. Default returns true (cycle still pending, marker written).
  const markRejectRefundMock = vi.fn(
    async () => args.markRejectRefundResult ?? true,
  );
  // F8-RP-2 review (Finding 3) — the in-flight-refund resolver the reject use-
  // case calls on the `refund_in_progress` path when the cycle has no marker.
  const findPendingRefundMock = vi.fn(
    async () =>
      args.findPendingRefundResult ?? { status: 'none' as const },
  );
  const f5Bridge: F5RefundBridge = {
    issueRefundForInvoice: refundMock as never,
    // The sync reject path never consults the settlement lookup; provide a
    // stub so the mock satisfies the F5RefundBridge port.
    getRefundOutcomeForInvoice: vi.fn(async () => ({
      status: 'not_found' as const,
    })),
    findPendingRefundForInvoice: findPendingRefundMock as never,
  };
  // I9 review-fix: stub `escalationTaskRepo.insertIfAbsent` so the
  // post-refund-review task path runs without persistence; default
  // returns `created: true` mirroring the steady-state idempotent miss.
  const insertTaskMock = vi.fn(
    async (
      _tx: unknown,
      input: {
        readonly taskId: string;
        readonly memberId: string;
        readonly cycleId: string | null;
        readonly taskType: string;
        readonly assignedToRole: 'admin' | 'manager' | 'executive_director';
        readonly dueAt: string;
      },
    ) => ({
      created: true,
      row: {
        tenantId: TENANT_ID,
        taskId: input.taskId,
        memberId: input.memberId,
        cycleId: input.cycleId,
        taskType: input.taskType,
        assignedToRole: input.assignedToRole,
        assignedToUserId: null,
        dueAt: input.dueAt,
        relatedSuggestionId: null,
        createdAt: new Date().toISOString(),
        status: 'open' as const,
        outcomeNote: null,
        skippedReason: null,
        closedByUserId: null,
        closedAt: null,
      },
    }),
  );
  const deps: AdminRejectReactivationDeps = {
    tenant: { slug: TENANT_ID } as AdminRejectReactivationDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => args.cycle),
      findByIdInTx: findByIdInTxMock,
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
      markRejectRefundInitiatedInTx: markRejectRefundMock,
    } as unknown as AdminRejectReactivationDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    } as unknown as AdminRejectReactivationDeps['auditEmitter'],
    escalationTaskRepo: {
      insertIfAbsent: insertTaskMock,
    } as unknown as AdminRejectReactivationDeps['escalationTaskRepo'],
    f5RefundBridge: f5Bridge,
  };
  return {
    deps,
    refundMock,
    transitionMock,
    emitInTxMock,
    insertTaskMock,
    markRejectRefundMock,
    findPendingRefundMock,
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_UUID,
  reason: 'fraud-flag-rejected',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('adminRejectReactivation (T137)', () => {
  beforeEach(() => {
    // 070 I2/I3 — reset the hoisted logger spy between tests so the
    // reconciliation-log assertions don't see prior tests' calls.
    vi.clearAllMocks();
  });

  it('happy path with refund — refunds + transitions + emits audit with credit_note_id', async () => {
    const cycle = buildCycle();
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycle,
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // F8-RP: the success output is now a tagged union; the rejected
      // (common) path keeps its exact shape under the `rejected` tag.
      expect(r.value.outcome).toBe('rejected');
      if (r.value.outcome === 'rejected') {
        expect(r.value.cycleStatus).toBe('cancelled');
        expect(r.value.closedReason).toBe('admin_rejected_with_refund');
        expect(r.value.refundCreditNoteId).toBe('cn-1');
      }
    }
    expect(refundMock).toHaveBeenCalledOnce();
    expect(refundMock.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT_ID,
      invoiceId: INVOICE_UUID,
      reason: 'fraud-flag-rejected',
    });
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'pending_admin_reactivation',
      to: 'cancelled',
      closedReason: 'admin_rejected_with_refund',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'lapsed_member_admin_reactivation_rejected',
      payload: {
        cycle_id: cycle.cycleId,
        refund_credit_note_id: 'cn-1',
      },
    });
  });

  it('cycle without linked invoice — refund call skipped, audit refund_credit_note_id=null', async () => {
    const cycle = buildCycle({ linkedInvoiceId: null });
    const { deps, refundMock, emitInTxMock } = fakeDeps({ cycle });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.outcome === 'rejected') {
      expect(r.value.refundCreditNoteId).toBeNull();
    }
    expect(refundMock).not.toHaveBeenCalled();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      payload: { refund_credit_note_id: null },
    });
  });

  it('F5 returns no_payment_found — proceeds with cycle cancel, audit credit_note_id=null', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock } = fakeDeps({
      cycle,
      refundResult: { status: 'no_payment_found' },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.outcome === 'rejected') {
      expect(r.value.refundCreditNoteId).toBeNull();
    }
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      payload: { refund_credit_note_id: null },
    });
  });

  it('F5 refund_failed — returns error + does NOT transition cycle', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock } = fakeDeps({
      cycle,
      refundResult: {
        status: 'refund_failed',
        errorCode: 'processor_unavailable',
        detail: 'Stripe 503',
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'refund_failed') {
      expect(r.error.errorCode).toBe('processor_unavailable');
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('F8-RP: F5 refund_pending — ok({outcome:refund_pending}), cycle NOT transitioned, no escalation task', async () => {
    // The async Stripe refund was created (row `pending`); the reject use-
    // case must NOT transition the cycle to `cancelled`, must NOT insert a
    // post-refund escalation task, and must NOT emit the `_rejected` audit —
    // the cycle stays `pending_admin_reactivation` and the async settlement
    // (webhook/sweep) + the reconcile cron resolve it later. Money-safe: the
    // pending row makes any retry hit F5's `refund_in_progress` guard.
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock, insertTaskMock } = fakeDeps({
      cycle,
      refundResult: {
        status: 'refund_pending',
        refundId: 'rfnd-async-1',
        processorRefundId: 're_async_1',
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('refund_pending');
      if (r.value.outcome === 'refund_pending') {
        expect(r.value.cycleStatus).toBe('pending_admin_reactivation');
        expect(r.value.refundId).toBe('rfnd-async-1');
        expect(r.value.processorRefundId).toBe('re_async_1');
      }
    }
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
    expect(insertTaskMock).not.toHaveBeenCalled();
  });

  it('F8-RP follow-up: refund_pending STAMPS the reject-refund marker (id + admin actor) for cron settle', async () => {
    // The async `refund_pending` short-circuit must DURABLY record that this
    // cycle was admin-rejected-with-refund so the reconcile cron can later
    // converge it to `cancelled` (parity with the sync path) instead of
    // letting the 30-day timeout lapse it. The marker carries the F5 refund id
    // (settlement lookup key) + the rejecting admin (audit-actor replay).
    const cycle = buildCycle();
    const { deps, markRejectRefundMock } = fakeDeps({
      cycle,
      refundResult: {
        status: 'refund_pending',
        refundId: 'rfnd-async-1',
        processorRefundId: 're_async_1',
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(markRejectRefundMock).toHaveBeenCalledOnce();
    // Signature: (tx, tenantId, cycleId, { initiatedAt, refundId, actorUserId }).
    expect(markRejectRefundMock.mock.calls[0]?.[3]).toMatchObject({
      refundId: 'rfnd-async-1',
      actorUserId: 'admin-1',
    });
    expect(markRejectRefundMock.mock.calls[0]?.[3].initiatedAt).toEqual(
      expect.any(String),
    );
  });

  it('Finding 3: refund_in_progress (no id) + UNMARKED cycle → resolves in-flight refund id via bridge + STAMPS the marker', async () => {
    // THE BUG: F5 `refund_in_progress` fires for ANY pending refund on the
    // payment — including one issued by the reconcile cron's day-30
    // `processTimeout` path, which leaves the cycle UNMARKED. If the reject
    // skipped stamping here (the pre-fix behaviour), the next cron pass would
    // re-time-out the cycle → `lapsed` (actor=cron), silently dropping the
    // admin's explicit reject. THE FIX: with no existing marker, resolve the
    // in-flight refund's id from F5 and stamp the marker so the reconcile
    // marked branch converges the cycle → `cancelled` with the admin actor.
    const cycle = buildCycle(); // rejectRefundInitiatedAt defaults to null
    const { deps, markRejectRefundMock, findPendingRefundMock } = fakeDeps({
      cycle,
      refundResult: { status: 'refund_pending' }, // refund_in_progress → no ids
      findPendingRefundResult: {
        status: 'found',
        refundId: 'rfnd-inflight-cron-1',
        processorRefundId: 're_inflight_1',
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('refund_pending');
    // The bridge was consulted to resolve the in-flight refund id.
    expect(findPendingRefundMock).toHaveBeenCalledOnce();
    // The marker is stamped with the RESOLVED id + the rejecting admin actor.
    expect(markRejectRefundMock).toHaveBeenCalledOnce();
    expect(markRejectRefundMock.mock.calls[0]?.[3]).toMatchObject({
      refundId: 'rfnd-inflight-cron-1',
      actorUserId: 'admin-1',
    });
  });

  it('Finding 3: refund_in_progress (no id) + cycle ALREADY marked (prior reject) → does NOT resolve or re-stamp (idempotent)', async () => {
    // A genuine prior reject already stamped the marker for this in-flight
    // refund. Re-stamping would overwrite that reject's actor — keep the
    // idempotent skip. The bridge resolution is NOT consulted.
    const cycle = buildCycle({
      rejectRefundInitiatedAt: '2026-04-02T00:00:00Z',
      rejectRefundId: 'rfnd-prior-reject-1',
      rejectActorUserId: 'admin-prior',
    });
    const { deps, markRejectRefundMock, findPendingRefundMock } = fakeDeps({
      cycle,
      refundResult: { status: 'refund_pending' },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('refund_pending');
    expect(findPendingRefundMock).not.toHaveBeenCalled();
    expect(markRejectRefundMock).not.toHaveBeenCalled();
  });

  it('Finding 3: refund_in_progress (no id) + UNMARKED but bridge returns none (TOCTOU) → does NOT stamp, still surfaces refund_pending', async () => {
    // The in-flight refund settled/vanished between F5's guard and the lookup
    // (TOCTOU), or the lookup failed. Do NOT fabricate an id, do NOT crash —
    // leave the cycle unmarked; the sweep/webhook + a later cron pass reconcile.
    const cycle = buildCycle();
    const { deps, markRejectRefundMock, findPendingRefundMock } = fakeDeps({
      cycle,
      refundResult: { status: 'refund_pending' },
      findPendingRefundResult: { status: 'none' },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('refund_pending');
    // The resolution WAS attempted (no marker existed) but returned nothing.
    expect(findPendingRefundMock).toHaveBeenCalledOnce();
    expect(markRejectRefundMock).not.toHaveBeenCalled();
  });

  it('Finding 3: refund_pending WITH a refundId (kind:pending path) still stamps directly, WITHOUT the bridge resolution', async () => {
    // Regression guard for the common async path: `issueRefund` → kind:'pending'
    // carries the refund id, so the reject stamps it directly and never needs
    // the in-flight resolver (the resolver is only for the id-less
    // refund_in_progress path).
    const cycle = buildCycle();
    const { deps, markRejectRefundMock, findPendingRefundMock } = fakeDeps({
      cycle,
      refundResult: {
        status: 'refund_pending',
        refundId: 'rfnd-async-1',
        processorRefundId: 're_async_1',
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(findPendingRefundMock).not.toHaveBeenCalled();
    expect(markRejectRefundMock).toHaveBeenCalledOnce();
    expect(markRejectRefundMock.mock.calls[0]?.[3]).toMatchObject({
      refundId: 'rfnd-async-1',
    });
  });

  it('cycle_not_found — null re-read after lock', async () => {
    const { deps, refundMock } = fakeDeps({ cycle: null });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('cycle_not_pending — status mismatch returns currentStatus', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, refundMock } = fakeDeps({ cycle });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_pending') {
      expect(r.error.currentStatus).toBe('completed');
    }
    expect(refundMock).not.toHaveBeenCalled();
  });

  it('TransitionConflict AFTER refund issued — server_error (manual reconciliation)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'pending_admin_reactivation',
          'cancelled',
        );
      },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('Principle VIII — audit emit failure throws to roll back transition', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(adminRejectReactivation(deps, baseInput)).rejects.toThrow(
      /audit_log: insert failed/,
    );
  });

  // ───────────────────────────────────────────────────────────────────────
  // 070 speckit-review I2 — reverse-direction Principle VIII rollbacks AFTER
  // the F5 refund issued. These are the highest-stakes uncovered failure
  // modes: money MOVED (refund + F4 credit-note are durable), then the F8
  // state tx rolls back, so the refund is orphaned and needs manual
  // reconciliation. Each path MUST (a) re-throw so the cycle transition rolls
  // back, and (b) log `refundIssuedRequiresReconciliation: true` with the
  // refundCreditNoteId so SRE can filter for refund-orphan rollbacks.
  // ───────────────────────────────────────────────────────────────────────

  it('I2a: audit emit (lapsed_member) throw AFTER refund → re-throws + logs refundIssuedRequiresReconciliation w/ credit-note id', async () => {
    const cycle = buildCycle(); // linkedInvoiceId set → a real refund issues
    const { deps, refundMock } = fakeDeps({
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: lapsed-member insert failed');
      },
    });

    await expect(adminRejectReactivation(deps, baseInput)).rejects.toThrow(
      /audit_log: lapsed-member insert failed/,
    );
    // The refund DID issue (credit-note 'cn-1' from the default refund mock).
    expect(refundMock).toHaveBeenCalledOnce();

    const reconcileLog = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { refundIssuedRequiresReconciliation?: boolean } | undefined)
          ?.refundIssuedRequiresReconciliation === true,
    );
    expect(reconcileLog).toBeDefined();
    expect(reconcileLog![0]).toMatchObject({
      refundCreditNoteId: 'cn-1',
      refundIssuedRequiresReconciliation: true,
    });
  });

  it('I2b: escalation-task insert throw AFTER refund → re-throws + logs refundIssuedRequiresReconciliation (refund stays issued)', async () => {
    const cycle = buildCycle();
    const { deps, insertTaskMock } = fakeDeps({ cycle });
    // The lapsed-member audit succeeds (default emit), then the
    // post_refund_review escalation-task insert throws — the use-case
    // RE-THROWS so the whole F8 state tx (cycle transition + lapsed-member
    // audit) rolls back; the F5 refund is already durable.
    insertTaskMock.mockRejectedValueOnce(
      new Error('renewal_escalation_tasks: insert failed'),
    );

    await expect(adminRejectReactivation(deps, baseInput)).rejects.toThrow(
      /renewal_escalation_tasks: insert failed/,
    );

    const reconcileLog = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { refundIssuedRequiresReconciliation?: boolean } | undefined)
          ?.refundIssuedRequiresReconciliation === true,
    );
    expect(reconcileLog).toBeDefined();
    expect(reconcileLog![0]).toMatchObject({
      refundCreditNoteId: 'cn-1',
      refundIssuedRequiresReconciliation: true,
    });
  });

  it('I2c: escalation-task audit (escalation_task_created) throw AFTER refund → re-throws + reconciliation log', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock } = fakeDeps({ cycle });
    // First emit = lapsed_member audit (succeeds). Second emit =
    // escalation_task_created audit (throws) → reverse-direction rollback.
    emitInTxMock
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error('audit_log: escalation_task_created insert failed');
      });

    await expect(adminRejectReactivation(deps, baseInput)).rejects.toThrow(
      /escalation_task_created insert failed/,
    );

    const reconcileLog = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { refundIssuedRequiresReconciliation?: boolean } | undefined)
          ?.refundIssuedRequiresReconciliation === true,
    );
    expect(reconcileLog).toBeDefined();
    expect(reconcileLog![0]).toMatchObject({
      refundCreditNoteId: 'cn-1',
      refundIssuedRequiresReconciliation: true,
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 070 speckit-review I3 — adminReject conflict-AFTER-refund maps to EXACTLY
  // `{ kind: 'server_error' }` (deterministic). The existing concurrent-double
  // -reject INTEGRATION test accepts any of server_error|cycle_not_pending|
  // refund_failed (timing-dependent), so the mapping is not deterministically
  // pinned anywhere. This unit test forces the transition to throw a
  // CycleTransitionConflictError AFTER a successful refund and asserts the
  // exact server_error result + the orphan-refund reconciliation log.
  // ───────────────────────────────────────────────────────────────────────

  it('I3: transition CycleTransitionConflictError AFTER refund → exactly { kind: server_error } + orphan-refund log', async () => {
    const cycle = buildCycle();
    const { deps, refundMock } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'pending_admin_reactivation',
          'cancelled',
        );
      },
    });

    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(false);
    // EXACT mapping — `kind` is deterministically `server_error`, NOT
    // refund_failed / cycle_not_pending (the integration test's timing-
    // tolerant set). The use-case attaches a redacted `message`; pin the
    // discriminant, not the human-readable copy.
    if (!r.ok) expect(r.error.kind).toBe('server_error');
    // The refund DID issue before the conflict (it is now orphaned).
    expect(refundMock).toHaveBeenCalledOnce();

    // Orphan-refund forensic log fired with the credit-note id so SRE can
    // reconcile the irreversible refund against the lost-race cycle.
    const orphanLog = loggerErrorMock.mock.calls.find(
      (c) =>
        typeof c[1] === 'string' &&
        (c[1] as string).includes('cycle transition lost race'),
    );
    expect(orphanLog).toBeDefined();
    expect(orphanLog![0]).toMatchObject({ refundCreditNoteId: 'cn-1' });
  });

  it('invalid_input on malformed cycleId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await adminRejectReactivation(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('I9 review-fix: refund-success path inserts post_refund_review escalation task + emits escalation_task_created audit', async () => {
    const cycle = buildCycle();
    const { deps, insertTaskMock, emitInTxMock } = fakeDeps({ cycle });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(insertTaskMock).toHaveBeenCalledOnce();
    expect(insertTaskMock.mock.calls[0]?.[1]).toMatchObject({
      tenantId: TENANT_ID,
      memberId: cycle.memberId,
      taskType: 'post_refund_review',
      assignedToRole: 'admin',
    });
    // Two audits emitted in tx: lapsed_member_admin_reactivation_rejected,
    // then escalation_task_created (when task was newly created).
    expect(emitInTxMock).toHaveBeenCalledTimes(2);
    expect(emitInTxMock.mock.calls[1]?.[1]).toMatchObject({
      type: 'escalation_task_created',
      payload: {
        task_type: 'post_refund_review',
        trigger_reason: 'admin_reject_with_refund',
        refund_credit_note_id: 'cn-1',
      },
    });
  });

  it('I9 review-fix: no_payment_found does NOT insert escalation task (no finance follow-up needed)', async () => {
    const cycle = buildCycle();
    const { deps, insertTaskMock, emitInTxMock } = fakeDeps({
      cycle,
      refundResult: { status: 'no_payment_found' },
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(insertTaskMock).not.toHaveBeenCalled();
    // Only the `lapsed_member_admin_reactivation_rejected` audit fires;
    // no `escalation_task_created` follow-up.
    expect(emitInTxMock).toHaveBeenCalledOnce();
  });

  it('invalid_input on empty reason', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await adminRejectReactivation(deps, {
      ...baseInput,
      reason: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
