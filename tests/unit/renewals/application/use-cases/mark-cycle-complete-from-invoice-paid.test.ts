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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  markCycleCompleteFromInvoicePaid,
  markCycleCompleteInTx,
} from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import type { MarkCycleCompleteDeps } from '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_ID = 'mem-123';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1230';
const INVOICE_UUID = '00000000-0000-0000-0000-0000000aaaaa';

// Round 2 review-fix (I-5): hoisted spy lets the I3 tx-thread test
// distinguish "tx threaded — runInTenant NOT called" (existingTx path)
// from "tx omitted — runInTenant called exactly once" (legacy
// backward-compat path). Round 1's passthrough mock could not tell
// these apart: the sentinel-identity assertion would still pass even
// if the production code accidentally re-wrapped in `runInTenant`,
// silently re-introducing the eventual-consistency window I3 closed.
//
// Round 3 review-fix (R3-I1+I2+I3): the `runInTenantOrReuse` helper
// was deleted from `@/lib/db` because the wrapper variant
// (`markCycleCompleteFromInvoicePaid`) now opens its own `runInTenant`
// directly + the InTx variant (`markCycleCompleteInTx`) takes the
// caller's tx — both paths are simpler than a shared helper. The
// hoisted spy on `runInTenant` alone still locks the S-11 invariant:
// passing tx → InTx must NOT call runInTenant; omitting tx → wrapper
// MUST call runInTenant exactly once.
const { runInTenantSpy } = vi.hoisted(() => ({
  runInTenantSpy: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
      fn({} as unknown),
  ),
}));

vi.mock('@/lib/db', () => ({
  runInTenant: runInTenantSpy,
}));

beforeEach(() => {
  runInTenantSpy.mockClear();
});

function buildEvent(overrides: Partial<F4InvoicePaidEvent> = {}): F4InvoicePaidEvent {
  return {
    tenantId: TENANT_ID,
    invoiceId: INVOICE_UUID,
    memberId: MEMBER_ID,
    paidAt: '2026-05-07T10:00:00Z',
    amountSatang: asSatang(5_000_000n),
    vatSatang: asSatang(350_000n),
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
    // Round 2 (S-10): use-case returns MarkCycleCompleteOutcome
    // directly (no Result wrapper). Discriminate via `kind`.
    expect(r.kind).toBe('completed');
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
    expect(r.kind).toBe('completed');
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
    expect(r.kind).toBe('held_pending_admin');
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
    expect(r.kind).toBe('no_cycle_for_invoice');
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('idempotent re-fire — cycle already completed, returns cycle_not_payable', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, transitionMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('completed');
    } else {
      throw new Error(`expected cycle_not_payable, got ${r.kind}`);
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
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('pending_admin_reactivation');
    } else {
      throw new Error(`expected cycle_not_payable, got ${r.kind}`);
    }
  });

  it('S-11 split: markCycleCompleteInTx reuses caller tx — runInTenant NOT called', async () => {
    // Round 2 review-fix (S-11): the use-case is split into two
    // variants. The InTx variant takes a caller-provided tx and
    // never opens its own runInTenant — locks the I3 atomic-tx
    // invariant at the type system level (no `existingTx?` branch
    // to forget). Round 1's hoisted spy still runs to prove the
    // assertion holds at runtime.
    const cycle = buildCycle();
    const { deps, findByInvoiceMock } = fakeDeps({ cycle });
    const sentinelTx = { sentinel: 'f4-tx-handle' } as never;
    const r = await markCycleCompleteInTx(deps, buildEvent(), sentinelTx);
    expect(r.kind).toBe('completed');
    // Assertion 1: sentinel-identity threads through to repo
    expect(findByInvoiceMock).toHaveBeenCalledWith(
      sentinelTx,
      TENANT_ID,
      INVOICE_UUID,
    );
    // Assertion 2: InTx variant does NOT call runInTenant — by
    // construction (no body wrapping) but locked by the spy.
    expect(runInTenantSpy).not.toHaveBeenCalled();
  });

  it('S-11 wrapper: markCycleCompleteFromInvoicePaid opens runInTenant exactly once', async () => {
    // Reciprocal: the wrapper variant DOES call runInTenant —
    // backward-compat half of the I3 contract.
    const cycle = buildCycle();
    const { deps, findByInvoiceMock } = fakeDeps({ cycle });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('completed');
    expect(runInTenantSpy).toHaveBeenCalledTimes(1);
    expect(findByInvoiceMock).toHaveBeenCalled();
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
    expect(r.kind).toBe('cycle_not_payable');
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

  // R11 coverage closure — holdForAdminReview private function had its
  // catch branch (CycleTransitionConflictError + CycleNotFoundError +
  // rethrow) uncovered. Same idempotent-skip semantics as the default
  // markCycleCompleteInTx path: if a concurrent confirm flipped the
  // cycle out of awaiting_payment, the F4 callback must NOT 5xx — it
  // returns cycle_not_payable so F4 sees an idempotent acknowledgement.

  it('blocked=true + transition CycleTransitionConflictError — idempotent skip (returns cycle_not_payable)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('cycle_not_payable');
    if (r.kind === 'cycle_not_payable') {
      expect(r.currentStatus).toBe('awaiting_payment');
    }
  });

  it('blocked=true + transition CycleNotFoundError — idempotent skip (returns cycle_not_payable)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new CycleNotFoundError(CYCLE_UUID);
      },
    });
    const r = await markCycleCompleteFromInvoicePaid(deps, buildEvent());
    expect(r.kind).toBe('cycle_not_payable');
  });

  it('blocked=true + non-conflict throw — propagates so F4 rolls back', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      blocked: true,
      transitionImpl: async () => {
        throw new Error('hold-for-admin connection reset');
      },
    });
    await expect(
      markCycleCompleteFromInvoicePaid(deps, buildEvent()),
    ).rejects.toThrow(/hold-for-admin connection reset/);
  });
});
