/**
 * F8-completion slice 2 · Task 2.3 — `enterAwaitingPaymentOnExpiry` spec.ts.
 *
 * The T-0 expiry cron flips cycles `upcoming|reminded` → `awaiting_payment`
 * once `expires_at <= now`, so the confirm + paid-completion paths become
 * reachable. Clone of `lapseCyclesOnGraceExpiry` minus the F5 bridge +
 * tenant-settings/grace lookup; the outcome taxonomy is
 * `flipped | race_skipped | error`.
 *
 * Branch coverage (stub repo):
 *   - Happy flip: eligible `upcoming` cycle → transitions upcoming →
 *     awaiting_payment + emits `renewal_entered_awaiting_payment`
 *     (source:'cron').
 *   - `reminded` flip: eligible `reminded` cycle → transitions reminded
 *     → awaiting_payment (the `from` mirrors the re-read status).
 *   - Race-loss (re-read drift): cycle moved out of `upcoming|reminded`
 *     between list + tx-bound re-read → counted in raceSkipped, no flip.
 *   - Race-loss (CAS throw): transitionStatus throws
 *     CycleTransitionConflictError / CycleNotFoundError → raceSkipped,
 *     NOT errors.
 *   - Generic transition throw → re-thrown + counted in errors.
 *   - Per-cycle error isolation: one throwing cycle counted + loop
 *     continues to the next.
 *   - acquireCycleLockInTx invoked with (tx, tenantId, cycleId).
 *   - Audit emit failure inside tx → counted in errors (Principle VIII
 *     reverse-direction: emit throws → tx rollback → no tally bump).
 *   - Count invariant: flipped + raceSkipped + errors === cyclesProcessed.
 *   - Invalid input → `invalid_input` from parseInput helper.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  enterAwaitingPaymentOnExpiry,
  type EnterAwaitingPaymentOnExpiryDeps,
} from '@/modules/renewals/application/use-cases/enter-awaiting-payment-on-expiry';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import {
  CycleTransitionConflictError,
  CycleNotFoundError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-30T08:00:00Z');

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function eligibleCycle(opts: {
  cycleSuffix?: string;
  status?: 'upcoming' | 'reminded';
}): RenewalCycle {
  const cycleSuffix = opts.cycleSuffix ?? 'c001';
  // expires_at = now - 1 day → at/past T-0.
  const expiresAt = new Date(NOW.getTime() - 86_400_000).toISOString();
  return buildCycleShared({
    cycleId: `00000000-0000-0000-0000-00000000${cycleSuffix}` as never,
    status: opts.status ?? 'upcoming',
    expiresAt,
  });
}

function fakeDeps(args: {
  cycles: RenewalCycle[];
  reReadCycle?: (cycle: RenewalCycle) => RenewalCycle | null;
  emitInTxImpl?: () => Promise<void>;
  transitionImpl?: () => Promise<RenewalCycle>;
}): {
  deps: EnterAwaitingPaymentOnExpiryDeps;
  emitInTxMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  acquireLockMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(async () => ({
    items: args.cycles,
    nextCursor: null,
  }));
  const findByIdInTxMock = vi.fn(
    async (_tx: unknown, _t: string, cid: string) => {
      const found = args.cycles.find((c) => c.cycleId === cid);
      return args.reReadCycle && found
        ? args.reReadCycle(found)
        : found ?? null;
    },
  );
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async (_tx: unknown, _t: string, cid: string) => {
        const found = args.cycles.find((c) => c.cycleId === cid);
        return { ...found!, status: 'awaiting_payment' as const };
      }),
  );
  const acquireLockMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));

  const deps: EnterAwaitingPaymentOnExpiryDeps = {
    tenant: { slug: TENANT_ID } as EnterAwaitingPaymentOnExpiryDeps['tenant'],
    cyclesRepo: {
      listCyclesEligibleForAwaitingPayment: listMock,
      findByIdInTx: findByIdInTxMock,
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
    } as unknown as EnterAwaitingPaymentOnExpiryDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as EnterAwaitingPaymentOnExpiryDeps['auditEmitter'],
  };
  return { deps, emitInTxMock, transitionMock, acquireLockMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  now: NOW,
  correlationId: 'corr-enter-awaiting-1',
};

describe('enterAwaitingPaymentOnExpiry (slice 2 / T2.3) — T-0 payability flip', () => {
  it('flips an eligible upcoming cycle → awaiting_payment + emits renewal_entered_awaiting_payment (source:cron)', async () => {
    const cycle = eligibleCycle({ status: 'upcoming' });
    const { deps, emitInTxMock, transitionMock } = fakeDeps({
      cycles: [cycle],
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(1);
      expect(r.value.flipped).toBe(1);
      expect(r.value.raceSkipped).toBe(0);
      expect(r.value.errors).toBe(0);
      // Count invariant.
      expect(
        r.value.flipped + r.value.raceSkipped + r.value.errors,
      ).toBe(r.value.cyclesProcessed);
    }
    expect(transitionMock).toHaveBeenCalledOnce();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'upcoming',
      to: 'awaiting_payment',
    });
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_entered_awaiting_payment',
      payload: expect.objectContaining({
        source: 'cron',
        cycle_id: cycle.cycleId,
        entered_at: NOW.toISOString(),
      }),
    });
    // Cron actor context.
    expect(emitInTxMock.mock.calls[0]?.[2]).toMatchObject({
      tenantId: TENANT_ID,
      actorUserId: null,
      actorRole: 'cron',
    });
  });

  it('flips an eligible reminded cycle → awaiting_payment (from mirrors the re-read status)', async () => {
    const cycle = eligibleCycle({ status: 'reminded' });
    const { deps, transitionMock } = fakeDeps({ cycles: [cycle] });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.flipped).toBe(1);
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'reminded',
      to: 'awaiting_payment',
    });
  });

  it('race-loss (re-read drift): cycle moved out of upcoming|reminded between list + re-read → raceSkipped, no flip', async () => {
    const cycle = eligibleCycle({});
    const { deps, transitionMock, emitInTxMock } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () =>
        ({ ...cycle, status: 'awaiting_payment' as const }) as RenewalCycle,
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.raceSkipped).toBe(1);
      expect(r.value.flipped).toBe(0);
      expect(r.value.errors).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('race-loss (re-read drift to terminal): re-read finds completed → raceSkipped', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () =>
        ({ ...cycle, status: 'completed' as const }) as RenewalCycle,
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.raceSkipped).toBe(1);
  });

  it('race-loss (re-read returns null): cycle deleted between list + re-read → raceSkipped', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () => null,
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.raceSkipped).toBe(1);
  });

  it('race-loss via CycleTransitionConflictError thrown by transitionStatus → raceSkipped, NOT errors', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          cycle.cycleId,
          'upcoming',
          'awaiting_payment',
        );
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.raceSkipped).toBe(1);
      expect(r.value.errors).toBe(0);
      expect(r.value.flipped).toBe(0);
    }
  });

  it('CycleNotFoundError thrown by transitionStatus → also raceSkipped', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleNotFoundError(cycle.cycleId);
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.raceSkipped).toBe(1);
      expect(r.value.errors).toBe(0);
    }
  });

  it('generic Error thrown by transitionStatus → re-thrown + counted in errors (NOT raceSkipped)', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new Error('db connection lost mid-transition');
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.errors).toBe(1);
      expect(r.value.raceSkipped).toBe(0);
    }
  });

  it('acquireCycleLockInTx invoked with (tx, tenantId, cycleId) — concurrency-defence lock', async () => {
    const cycle = eligibleCycle({});
    const { deps, acquireLockMock } = fakeDeps({ cycles: [cycle] });
    await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(acquireLockMock).toHaveBeenCalledTimes(1);
    expect(acquireLockMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      cycle.cycleId,
    );
  });

  it('audit emit failure inside tx → counted in errors (Principle VIII reverse-direction rolls tx back)', async () => {
    const cycle = eligibleCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.errors).toBe(1);
      expect(r.value.flipped).toBe(0); // rollback prevents tally bump
    }
  });

  it('per-cycle error isolation: one throwing cycle counted + cron continues to the next', async () => {
    const cycleA = eligibleCycle({ cycleSuffix: 'c001' });
    const cycleB = eligibleCycle({ cycleSuffix: 'c002' });
    let call = 0;
    const { deps } = fakeDeps({
      cycles: [cycleA, cycleB],
      transitionImpl: async (
        _tx?: unknown,
        _t?: string,
        cid?: string,
      ) => {
        call += 1;
        if (call === 1) throw new Error('transient db blip on cycleA');
        return { ...cycleB, cycleId: cid, status: 'awaiting_payment' as const } as RenewalCycle;
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(2);
      expect(r.value.errors).toBe(1);
      expect(r.value.flipped).toBe(1); // cycleB succeeded
      expect(
        r.value.flipped + r.value.raceSkipped + r.value.errors,
      ).toBe(r.value.cyclesProcessed);
    }
  });

  it('count invariant holds for a mixed run: 1 flipped + 1 raceSkipped + 1 error === 3 processed', async () => {
    const cFlip = eligibleCycle({ cycleSuffix: 'c001' });
    const cRace = eligibleCycle({ cycleSuffix: 'c002' });
    const cErr = eligibleCycle({ cycleSuffix: 'c003' });
    const { deps } = fakeDeps({
      cycles: [cFlip, cRace, cErr],
      reReadCycle: (cycle) =>
        cycle.cycleId === cRace.cycleId
          ? ({ ...cycle, status: 'awaiting_payment' as const } as RenewalCycle)
          : cycle,
      transitionImpl: async (_tx?: unknown, _t?: string, cid?: string) => {
        if (cid === cErr.cycleId) throw new Error('db blip on cErr');
        const found = [cFlip, cRace, cErr].find((c) => c.cycleId === cid)!;
        return { ...found, status: 'awaiting_payment' as const } as RenewalCycle;
      },
    });
    const r = await enterAwaitingPaymentOnExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(3);
      expect(r.value.flipped).toBe(1);
      expect(r.value.raceSkipped).toBe(1);
      expect(r.value.errors).toBe(1);
      expect(
        r.value.flipped + r.value.raceSkipped + r.value.errors,
      ).toBe(r.value.cyclesProcessed);
    }
  });

  it('invalid_input: missing required field → invalid_input error from parseInput', async () => {
    const { deps } = fakeDeps({ cycles: [] });
    const r = await enterAwaitingPaymentOnExpiry(
      deps,
      // @ts-expect-error testing the runtime guard
      { tenantId: TENANT_ID, now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
