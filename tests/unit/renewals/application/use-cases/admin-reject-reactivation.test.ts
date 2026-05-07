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
    f5RefundBridge: f5Bridge,
  };
  return { deps, refundMock, transitionMock, emitInTxMock };
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
