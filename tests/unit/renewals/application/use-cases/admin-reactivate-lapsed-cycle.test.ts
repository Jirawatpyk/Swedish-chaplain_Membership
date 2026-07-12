/**
 * F8 Phase 5 Wave A · T136 spec — `adminReactivateLapsedCycle`.
 *
 * Admin approves cycle stuck in `pending_admin_reactivation`. Verifies:
 *   - Happy path (transition + audit)
 *   - cycle_not_found
 *   - cycle_not_pending (status mismatch)
 *   - CycleTransitionConflict → cycle_not_pending re-read
 *   - Principle VIII reverse-direction (audit failure rolls back)
 */
import { describe, expect, it, vi } from 'vitest';
import { adminReactivateLapsedCycle } from '@/modules/renewals/application/use-cases/admin-reactivate-lapsed-cycle';
import { CycleTransitionConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1d36';

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
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  reReadCycle?: RenewalCycle | null;
  transitionImpl?: () => Promise<RenewalCycle>;
  emitImpl?: () => Promise<void>;
}): {
  deps: RenewalsDeps;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  acquireLockMock: ReturnType<typeof vi.fn>;
} {
  const findByIdInTxMock = vi
    .fn()
    .mockResolvedValueOnce(args.cycle)
    .mockResolvedValueOnce(args.reReadCycle ?? args.cycle);
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async () => ({ ...args.cycle!, status: 'completed' as const })),
  );
  const acquireLockMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(args.emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => args.cycle),
      findByIdInTx: findByIdInTxMock,
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, transitionMock, emitInTxMock, acquireLockMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_UUID,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('adminReactivateLapsedCycle (T136)', () => {
  it('happy path — transitions to completed + emits audit', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock, acquireLockMock } = fakeDeps({
      cycle,
    });
    const r = await adminReactivateLapsedCycle(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cycleStatus).toBe('completed');
      expect(r.value.closedReason).toBe('admin_reactivated');
    }
    expect(acquireLockMock).toHaveBeenCalledOnce();
    expect(transitionMock).toHaveBeenCalledOnce();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'pending_admin_reactivation',
      to: 'completed',
      closedReason: 'admin_reactivated',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'lapsed_member_admin_reactivated',
      payload: {
        cycle_id: cycle.cycleId,
        member_id: cycle.memberId,
        actor_user_id: 'admin-1',
      },
    });
  });

  it('cycle_not_found — null re-read after lock', async () => {
    const { deps } = fakeDeps({ cycle: null });
    const r = await adminReactivateLapsedCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
  });

  it('cycle_not_pending — status mismatch returns currentStatus', async () => {
    const cycle = buildCycle({ status: 'awaiting_payment' });
    const { deps, transitionMock } = fakeDeps({ cycle });
    const r = await adminReactivateLapsedCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_pending') {
      expect(r.error.currentStatus).toBe('awaiting_payment');
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('reject_refund_in_progress — marked pending cycle refuses reactivation, no transition (UX-A Bug 1)', async () => {
    // A cycle whose admin REJECT initiated an async F5 refund carries the
    // reject-refund marker (`rejectRefundInitiatedAt`) while it stays
    // `pending_admin_reactivation`. Approving it would reactivate the member
    // WHILE their money is being refunded — a contradictory state the reconcile
    // cron (pending-only) never converges. The guard must refuse under the lock
    // (atomic CAS on the tx-bound re-read).
    const cycle = buildCycle({
      rejectRefundInitiatedAt: '2026-04-05T00:00:00Z',
      rejectRefundId: 'rfnd_01H',
      rejectActorUserId: 'admin-2',
    });
    const { deps, transitionMock, emitInTxMock } = fakeDeps({ cycle });
    const r = await adminReactivateLapsedCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('reject_refund_in_progress');
    // No reactivation transition, no audit emit — the decision is already made.
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('TransitionConflict — re-read returns user-friendly cycle_not_pending', async () => {
    const cycle = buildCycle();
    const reRead = buildCycle({ status: 'completed' });
    const { deps } = fakeDeps({
      cycle,
      reReadCycle: reRead,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'pending_admin_reactivation',
          'completed',
        );
      },
    });
    const r = await adminReactivateLapsedCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_pending') {
      expect(r.error.currentStatus).toBe('completed');
    }
  });

  it('Principle VIII — audit emit failure rolls back tx', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(
      adminReactivateLapsedCycle(deps, baseInput),
    ).rejects.toThrow(/audit_log: insert failed/);
  });

  it('invalid_input on malformed cycleId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await adminReactivateLapsedCycle(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
