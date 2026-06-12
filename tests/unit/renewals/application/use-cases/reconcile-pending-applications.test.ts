/**
 * F8 Phase 7 T185 — `reconcilePendingApplications` use-case (unit).
 *
 * 065 S1/S2 — the weekly reconcile cron's per-orphan catch must
 * DISCRIMINATE the benign `TierUpgradeStatusConflictError` (CAS-loser:
 * a concurrent accept / supersede / apply already resolved the orphan
 * between the `listOrphanedPending` read and this dismiss UPDATE) from
 * a genuine dismiss failure. The benign skip must NOT bump the
 * alertable `tierUpgradeReconcileErrors` counter nor log at `error`
 * level (which would page on-call for a self-healing race), and the
 * run must be reported clean with the accounting invariant
 * `detected === dismissed + skippedBenign + (genuine failures)`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { reconcilePendingApplications } from '@/modules/renewals/application/use-cases/reconcile-pending-applications';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import { TierUpgradeStatusConflictError } from '@/modules/renewals/application/ports/tier-upgrade-suggestion-repo';

const reconcileErrorsMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    tierUpgradeReconcileErrors: reconcileErrorsMock,
  },
}));

const loggerErrorMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  logger: {
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
  },
}));

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-09T00:00:00.000Z');
const SUG_UUID_1 = '00000000-0000-0000-0000-0000000a0001';
const SUG_UUID_2 = '00000000-0000-0000-0000-0000000a0002';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c0001';
const MEMBER_UUID = '00000000-0000-0000-0000-0000000b0001';

type Orphan = Awaited<
  ReturnType<RenewalsDeps['tierUpgradeRepo']['listOrphanedPending']>
>[number];

function orphan(suggestionId: string): Orphan {
  return {
    suggestion: {
      tenantId: TENANT_ID,
      suggestionId,
      memberId: MEMBER_UUID,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidence: {},
      suppressedUntil: null,
      memberNotifiedAt: null,
      adminVerificationTaskId: null,
      createdAt: NOW.toISOString(),
      status: 'accepted_pending_apply',
      acceptedAt: NOW.toISOString(),
      acceptedByUserId: 'admin-1',
      targetApplyAtCycleId: CYCLE_UUID,
      appliedAt: null,
      appliedAtInvoiceId: null,
      dismissedReason: null,
      closedAt: null,
    },
    targetCycleStatus: 'cancelled',
  } as unknown as Orphan;
}

function fakeDeps(args: {
  orphans: Orphan[];
  transitionImpl?: (suggestionId: string) => Promise<unknown>;
}): {
  deps: RenewalsDeps;
  transitionMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const transitionMock = vi.fn(
    async (
      _tx: unknown,
      _t: string,
      suggestionId: string,
    ): Promise<unknown> =>
      args.transitionImpl ? args.transitionImpl(suggestionId) : {},
  );
  const emitInTxMock = vi.fn(async () => {});
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    clock: { now: () => NOW },
    tierUpgradeRepo: {
      listOrphanedPending: vi.fn(async () => args.orphans),
      transitionStatus: transitionMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, transitionMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  correlationId: 'corr-1',
};

describe('reconcilePendingApplications (T185) — 065 S1/S2 benign-conflict skip', () => {
  beforeEach(() => {
    reconcileErrorsMock.mockReset();
    loggerErrorMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('benign CAS-loser — no error counter, no error log, counted as benign skip, run clean', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      orphans: [orphan(SUG_UUID_1)],
      transitionImpl: async () => {
        throw new TierUpgradeStatusConflictError(
          SUG_UUID_1,
          'accepted_pending_apply',
          'superseded',
        );
      },
    });

    const r = await reconcilePendingApplications(deps, baseInput);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Detected the orphan, but it was already resolved concurrently.
    expect(r.value.orphansDetected).toBe(1);
    expect(r.value.orphansDismissed).toBe(0);
    expect(r.value.orphansSkippedBenign).toBe(1);

    // The alertable counter MUST NOT fire for a benign self-healing race.
    expect(reconcileErrorsMock).not.toHaveBeenCalled();
    // No error-level log (would page on-call); an info-level skip is fine.
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    // Conflict happened BEFORE the audit emit, so no audit row written.
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('loop continues past a benign skip and still dismisses the next orphan', async () => {
    const { deps, transitionMock } = fakeDeps({
      orphans: [orphan(SUG_UUID_1), orphan(SUG_UUID_2)],
      transitionImpl: async (suggestionId) => {
        if (suggestionId === SUG_UUID_1) {
          throw new TierUpgradeStatusConflictError(
            SUG_UUID_1,
            'accepted_pending_apply',
            'applied',
          );
        }
        return {};
      },
    });

    const r = await reconcilePendingApplications(deps, baseInput);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.orphansDetected).toBe(2);
    expect(r.value.orphansDismissed).toBe(1);
    expect(r.value.orphansSkippedBenign).toBe(1);
    // Both orphans were attempted (loop did not abort on the first).
    expect(transitionMock).toHaveBeenCalledTimes(2);
    expect(reconcileErrorsMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('genuine dismiss failure — DOES bump the alertable counter + error log', async () => {
    const { deps } = fakeDeps({
      orphans: [orphan(SUG_UUID_1)],
      transitionImpl: async () => {
        throw new Error('neon connection reset');
      },
    });

    const r = await reconcilePendingApplications(deps, baseInput);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.orphansDetected).toBe(1);
    expect(r.value.orphansDismissed).toBe(0);
    expect(r.value.orphansSkippedBenign).toBe(0);
    // Real failure — the counter fires and on-call gets a paging log.
    expect(reconcileErrorsMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it('happy path — orphan dismissed, no counter, no skip', async () => {
    const { deps, emitInTxMock } = fakeDeps({
      orphans: [orphan(SUG_UUID_1)],
    });

    const r = await reconcilePendingApplications(deps, baseInput);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.orphansDetected).toBe(1);
    expect(r.value.orphansDismissed).toBe(1);
    expect(r.value.orphansSkippedBenign).toBe(0);
    expect(reconcileErrorsMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
  });
});
