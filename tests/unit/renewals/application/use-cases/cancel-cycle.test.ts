/**
 * F8 Phase 3 Wave H2 · T058 spec — `cancelCycle` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path per
 * Constitution coverage table).
 *
 * runInTenant is stubbed via partial deps mock — the real
 * implementation wraps in a Drizzle tx; tests verify the use-case
 * invokes `transitionStatus` + `auditEmitter.emitInTx` regardless of
 * tx mechanics.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { cancelCycle } from '@/modules/renewals/application/use-cases/cancel-cycle';
import {
  CycleTransitionConflictError,
  CycleNotFoundError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c2';
const TENANT_ID = 'tenantA';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: TENANT_ID,
    cycleId: asCycleId(VALID_UUID),
    memberId: 'mem-1',
    status: 'awaiting_payment' as const,
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

function fakeDeps(
  cycle: RenewalCycle | null,
  transitionImpl?: () => Promise<RenewalCycle>,
): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(async () => {});
  const transitionMock = vi.fn(
    transitionImpl ?? (async () => ({ ...cycle!, status: 'cancelled' as const })),
  );
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
      transitionStatus: transitionMock,
      acquireCycleLockInTx: vi.fn(async () => {}),
    } as unknown as RenewalsDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, emitInTxMock, transitionMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: VALID_UUID,
  reason: 'member leaving',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('cancelCycle (T058) — happy path', () => {
  it('transitions to cancelled + emits audit', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock, transitionMock } = fakeDeps(cycle);
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('cancelled');
      expect(r.value.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ type: 'renewal_cycle_cancelled' }),
    );
  });
});

describe('cancelCycle — error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid_input on bad cycleId', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, { ...baseInput, cycleId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('returns invalid_input on empty reason', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, { ...baseInput, reason: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('returns invalid_input on >500-char reason', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await cancelCycle(deps, {
      ...baseInput,
      reason: 'x'.repeat(501),
    });
    expect(r.ok).toBe(false);
  });

  it('returns cycle_not_found + emits probe on missing cycle', async () => {
    const { deps, emitMock } = fakeDeps(null);
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'renewal_cross_tenant_probe' }),
      expect.any(Object),
    );
  });

  it('returns cycle_not_cancellable on terminal state', async () => {
    const { deps } = fakeDeps(buildCycle({ status: 'completed' }));
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_cancellable');
      if (r.error.kind === 'cycle_not_cancellable') {
        expect(r.error.currentStatus).toBe('completed');
      }
    }
  });

  it('maps CycleTransitionConflictError to cycle_not_cancellable', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new CycleTransitionConflictError(
        cycle.cycleId,
        cycle.status,
        'cancelled',
      );
    });
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_cancellable');
    }
  });

  it('maps CycleNotFoundError (RLS race) to cycle_not_found', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new CycleNotFoundError(cycle.cycleId);
    });
    const r = await cancelCycle(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
  });

  it('rethrows unexpected errors', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => {
      throw new Error('db connection lost');
    });
    await expect(cancelCycle(deps, baseInput)).rejects.toThrow(
      'db connection lost',
    );
  });
});
