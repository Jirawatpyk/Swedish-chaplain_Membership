/**
 * F8 Phase 5 Wave B · T123 spec — `markCycleCompleteFromInvoicePaid`.
 *
 * F4 onPaidCallback target. Verifies:
 *   - Default auto-complete branch
 *   - FR-005b admin-block branch → held in pending_admin_reactivation
 *   - no-cycle-for-invoice (non-renewal payment, idempotent)
 *   - Idempotent re-fire (cycle already completed)
 *   - Race-condition skip (TransitionConflict)
 *   - Atomic state+audit (Principle VIII reverse-direction)
 */
import { describe, expect, it, vi } from 'vitest';
import { markCycleCompleteFromInvoicePaid } from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import type { MarkCycleCompleteDeps } from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import { CycleTransitionConflictError } from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-123';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1230';
const INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaaa';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildEvent(overrides: Partial<F4InvoicePaidEvent> = {}): F4InvoicePaidEvent {
  return {
    tenantId: TENANT_ID,
    invoiceId: INVOICE_UUID,
    memberId: MEMBER_ID,
    paidAt: '2026-05-07T10:00:00Z',
    amountSatang: 5_000_000n,
    vatSatang: 350_000n,
    currency: 'THB',
    paymentMethod: 'stripe_card',
    triggeredBy: 'webhook',
    ...overrides,
  };
}

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_ID,
    status: 'awaiting_payment',
    linkedInvoiceId: INVOICE_UUID,
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  blocked?: boolean | null;
  transitionImpl?: () => Promise<RenewalCycle>;
  emitInTxImpl?: () => Promise<void>;
}): {
  deps: MarkCycleCompleteDeps;
  findByInvoiceMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  readBlockedMock: ReturnType<typeof vi.fn>;
} {
  const findByInvoiceMock = vi.fn(async () => args.cycle ?? null);
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async () => ({ ...args.cycle!, status: 'completed' as const })),
  );
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  const readBlockedMock = vi.fn(async () =>
    args.blocked === undefined ? false : args.blocked,
  );
  const deps: MarkCycleCompleteDeps = {
    tenant: { slug: TENANT_ID } as MarkCycleCompleteDeps['tenant'],
    cyclesRepo: {
      findByInvoiceIdInTx: findByInvoiceMock,
      transitionStatus: transitionMock,
    } as unknown as MarkCycleCompleteDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    } as unknown as MarkCycleCompleteDeps['auditEmitter'],
    memberRenewalFlagsRepo: {
      readBlockedFromAutoReactivation: readBlockedMock,
    } as unknown as MarkCycleCompleteDeps['memberRenewalFlagsRepo'],
  };
  return {
    deps,
    findByInvoiceMock,
    transitionMock,
    emitInTxMock,
    readBlockedMock,
  };
}

describe('markCycleCompleteFromInvoicePaid (T123) — auto-complete branch', () => {
  it('happy path — transitions to completed + emits renewal_completed audit', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('completed');
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'completed',
      closedReason: 'paid',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed',
      payload: { invoice_id: INVOICE_UUID, payment_method: 'stripe_card' },
    });
  });

  it('blocked=null (member missing) — proceeds with auto-complete (defensive)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle, blocked: null });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('completed');
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — FR-005b admin-block branch', () => {
  it('blocked=true — held in pending_admin_reactivation + emits renewal_completed_post_lapse', async () => {
    const cycle = buildCycle();
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => ({
        ...cycle,
        status: 'pending_admin_reactivation' as const,
        enteredPendingAt: '2026-05-07T10:00:00Z',
      } as never),
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('held_pending_admin');
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'pending_admin_reactivation',
      enteredPendingAt: '2026-05-07T10:00:00Z',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_completed_post_lapse',
      payload: { held_for_admin_review: true },
    });
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — non-renewal + idempotent paths', () => {
  it('no_cycle_for_invoice when invoice has no F8 cycle (e.g. ad-hoc admin invoice)', async () => {
    const { deps, transitionMock } = fakeDeps({ cycle: null });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('no_cycle_for_invoice');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('idempotent re-fire — cycle already completed, returns cycle_not_payable', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, transitionMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'cycle_not_payable') {
      expect(r.value.currentStatus).toBe('completed');
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('cycle in pending_admin_reactivation — skip (admin already holds)', async () => {
    const cycle = buildCycle({
      status: 'pending_admin_reactivation',
      enteredPendingAt: '2026-04-01T00:00:00Z',
    });
    const { deps } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'cycle_not_payable') {
      expect(r.value.currentStatus).toBe('pending_admin_reactivation');
    }
  });
});

describe('markCycleCompleteFromInvoicePaid (T123) — race + atomicity', () => {
  it('TransitionConflict — idempotent skip (admin moved cycle out of awaiting_payment)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('cycle_not_payable');
  });

  it('Principle VIII — audit emit failure throws (rolls back F4 invoice)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/audit_log: insert failed/);
  });

  it('infra throw on transition (non-conflict) — propagates so F4 rolls back', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      transitionImpl: async () => {
        throw new Error('connection reset');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/connection reset/);
  });
});
