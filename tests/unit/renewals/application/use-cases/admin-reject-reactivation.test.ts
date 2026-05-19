/**
 * F8 Phase 5 Wave A.5 · T137 spec — `adminRejectReactivation`.
 *
 * Critical-path coverage: state validation, F5 refund bridge, atomic
 * tx for cycle transition + audit, post-refund reconciliation edge.
 */
import { describe, expect, it, vi } from 'vitest';
import { adminRejectReactivation } from '@/modules/renewals/application/use-cases/admin-reject-reactivation';
import type { AdminRejectReactivationDeps } from '@/modules/renewals/application/use-cases/admin-reject-reactivation';
import { CycleTransitionConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  F5RefundBridge,
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
}): {
  deps: AdminRejectReactivationDeps;
  refundMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  insertTaskMock: ReturnType<typeof vi.fn>;
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
  const f5Bridge: F5RefundBridge = {
    issueRefundForInvoice: refundMock as never,
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
  return { deps, refundMock, transitionMock, emitInTxMock, insertTaskMock };
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
  it('happy path with refund — refunds + transitions + emits audit with credit_note_id', async () => {
    const cycle = buildCycle();
    const { deps, refundMock, transitionMock, emitInTxMock } = fakeDeps({
      cycle,
    });
    const r = await adminRejectReactivation(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cycleStatus).toBe('cancelled');
      expect(r.value.closedReason).toBe('admin_rejected_with_refund');
      expect(r.value.refundCreditNoteId).toBe('cn-1');
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
    if (r.ok) expect(r.value.refundCreditNoteId).toBeNull();
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
    if (r.ok) expect(r.value.refundCreditNoteId).toBeNull();
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
