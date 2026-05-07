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
}): {
  deps: ReconcilePendingReactivationsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  refundMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
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
  };
  return { deps, emitMock, emitInTxMock, refundMock, transitionMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  now: NOW,
  correlationId: 'corr-cron-1',
};

describe('reconcilePendingReactivations (T138) — reminder ladder', () => {
  it.each([
    [23, 'lapsed_member_admin_reactivation_reminder_t-7' as const, 'remindersT7'],
    [27, 'lapsed_member_admin_reactivation_reminder_t-3' as const, 'remindersT3'],
    [29, 'lapsed_member_admin_reactivation_reminder_t-1' as const, 'remindersT1'],
  ])(
    'day %i emits %s audit',
    async (days, expectedType, counterKey) => {
      const cycle = pendingCycle({ daysPending: days });
      const { deps, emitMock, refundMock } = fakeDeps({ cycles: [cycle] });
      const r = await reconcilePendingReactivations(deps, baseInput);
      expect(r.ok).toBe(true);
      expect(refundMock).not.toHaveBeenCalled();
      expect(emitMock.mock.calls[0]?.[0]).toMatchObject({ type: expectedType });
      if (r.ok) {
        const counters = r.value as unknown as Record<string, number>;
        expect(counters[counterKey]).toBe(1);
      }
    },
  );

  it('day 22 / 25 / 28 — no audit (between boundaries)', async () => {
    const cycles = [22, 25, 28].map((days, i) =>
      pendingCycle({ daysPending: days, cycleSuffix: `c00${i}` }),
    );
    const { deps, emitMock } = fakeDeps({ cycles });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('reconcilePendingReactivations (T138) — auto-timeout', () => {
  it('day 30 — refunds + cancels cycle + emits timed_out audit', async () => {
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
      to: 'cancelled',
      closedReason: 'admin_rejected_with_refund',
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

  it('race — re-read shows cycle no longer pending → skip transition silently', async () => {
    const cycle = pendingCycle({ daysPending: 30 });
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () => ({ ...cycle, status: 'completed' } as unknown as typeof cycle),
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.timedOut).toBe(1); // counted as success (refund happened)
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
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

  it('mixed cycles — counts each branch independently', async () => {
    const cycles = [
      pendingCycle({ daysPending: 23, cycleSuffix: 'c071' }),
      pendingCycle({ daysPending: 27, cycleSuffix: 'c072' }),
      pendingCycle({ daysPending: 29, cycleSuffix: 'c073' }),
      pendingCycle({ daysPending: 30, cycleSuffix: 'c074' }),
      pendingCycle({ daysPending: 10, cycleSuffix: 'c075' }), // no-op
    ];
    const { deps } = fakeDeps({ cycles });
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

  it('audit emit failure on reminder path is swallowed (cron must not abort)', async () => {
    const cycle = pendingCycle({ daysPending: 23 });
    const { deps } = fakeDeps({
      cycles: [cycle],
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await reconcilePendingReactivations(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.remindersT7).toBe(1); // still counted
  });
});
