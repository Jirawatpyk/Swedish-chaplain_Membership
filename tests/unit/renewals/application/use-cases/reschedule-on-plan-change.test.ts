/**
 * F8 Phase 7 Round 4 IMP-4 — regression unit tests for
 * `rescheduleOnPlanChangeInTx`.
 *
 * Locks the Round 3 + Round 4 CRIT-1 fix: both audit emit sites
 * (skip-path + success-path) use `emit()` (own tx) NOT `emitInTx`,
 * so a runtime DB fault inside the audit emit MUST be caught
 * inside the per-emit try/catch (Round 4 IMP-8) — the listener
 * MUST NOT re-throw, otherwise the F3-owned plan-change tx
 * (members.change-plan caller) would silently rollback via
 * Postgres tainted-tx semantics.
 *
 * Without these tests, a future "Principle VIII purist" PR could
 * revert to `emitInTx` and the suite would stay GREEN — exactly
 * the regression class Round 3 + Round 4 fixed.
 */
import { describe, expect, it, vi } from 'vitest';
import { rescheduleOnPlanChangeInTx } from '@/modules/renewals/application/use-cases/reschedule-on-plan-change';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { TenantTx } from '@/lib/db';

const TENANT_ID = 'tenantA';
const MEMBER_ID = '00000000-0000-0000-0000-000000000001';
const FAKE_TX = {} as unknown as TenantTx;

interface DepsBuilder {
  readonly oldFound: boolean;
  readonly newFound: boolean;
  readonly emitImpl?: () => Promise<unknown>;
}

function fakeDeps({ oldFound, newFound, emitImpl }: DepsBuilder): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn(emitImpl ?? (async () => undefined));
  const emitInTxMock = vi.fn(async () => undefined);
  const deps = {
    tenant: { slug: TENANT_ID },
    planLookupForRenewal: {
      loadPlanFrozenFields: vi.fn(async (args: { planId: string }) => {
        const found = args.planId === 'old' ? oldFound : newFound;
        return found
          ? { status: 'found' as const, plan: { tierBucket: 'regular' as const } }
          : { status: 'not_found' as const };
      }),
    },
    auditEmitter: { emit: emitMock, emitInTx: emitInTxMock },
    cyclesRepo: { findActiveForMember: vi.fn(async () => null) },
    schedulePolicyRepo: { findByBucket: vi.fn(async () => null) },
    clock: { now: () => new Date('2026-08-15T00:00:00Z') },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, emitInTxMock };
}

const baseArgs = {
  tenantId: TENANT_ID,
  memberId: MEMBER_ID,
  oldPlanId: 'old',
  newPlanId: 'new',
  correlationId: 'corr-1',
  requestId: null,
};

describe('rescheduleOnPlanChangeInTx (R4 regression)', () => {
  it('R4-IMP-4 — old plan not_found path uses emit() (own tx), NOT emitInTx', async () => {
    const { deps, emitMock, emitInTxMock } = fakeDeps({
      oldFound: false,
      newFound: true,
    });
    await rescheduleOnPlanChangeInTx(deps, FAKE_TX, baseArgs);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).not.toHaveBeenCalled();
    const [event] = emitMock.mock.calls[0] ?? [];
    expect((event as { type?: string })?.type).toBe(
      'renewal_schedule_reschedule_skipped',
    );
  });

  it('R4-IMP-4 — both not_found path uses emit() with reason="both_not_found"', async () => {
    const { deps, emitMock } = fakeDeps({ oldFound: false, newFound: false });
    await rescheduleOnPlanChangeInTx(deps, FAKE_TX, baseArgs);
    const [event] = emitMock.mock.calls[0] ?? [];
    const payload = (event as { payload?: { reason?: string } })?.payload;
    expect(payload?.reason).toBe('both_not_found');
  });

  it('R4-CRIT-1 — audit emit failure on skip path is SWALLOWED (caller tx not tainted)', async () => {
    // Round 4 regression lock: a future revert from `emit()` to
    // `emitInTx()` would propagate this rejection up to the
    // caller's tx → silent rollback. The catch + counter pattern
    // we shipped in Round 4 IMP-8 catches it instead.
    const { deps, emitMock } = fakeDeps({
      oldFound: false,
      newFound: true,
      emitImpl: async () => {
        throw new Error('synthetic_audit_emit_failure');
      },
    });
    // The use-case MUST NOT throw — it MUST swallow + return.
    await expect(
      rescheduleOnPlanChangeInTx(deps, FAKE_TX, baseArgs),
    ).resolves.toEqual({
      cancelledStepIds: [],
      newStepIds: [],
      oldTierBucket: null,
      newTierBucket: 'regular',
    });
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it('R4-IMP-4 — same-bucket no-op early returns without any emit', async () => {
    const { deps, emitMock, emitInTxMock } = fakeDeps({
      oldFound: true,
      newFound: true,
    });
    await rescheduleOnPlanChangeInTx(deps, FAKE_TX, baseArgs);
    expect(emitMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });
});
