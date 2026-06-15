/**
 * 070 speckit-review I1 — direct unit test for `finaliseF2PlanChangeOnPaid`
 * driven with the **OFFLINE** actor (`{ actorUserId, requestId:
 * 'mark-paid-offline:<cycleId>' }`, NOT the `defaultOnlineF2Actor` sentinel).
 *
 * The ONLINE path (`'system:f8-on-paid-webhook'` sentinel) is covered via
 * `tests/unit/renewals/infrastructure/f8-on-paid-callbacks.test.ts`. The
 * OFFLINE actor path (used by `mark-paid-offline.ts` 070 Item D) had NO direct
 * coverage of the helper's branches under the admin actor — most critically
 * the S6 money-safety `superseded`-skip: a pending F2 row whose linked
 * suggestion is `superseded` (a cancelled upgrade) must NOT be flipped
 * pending → applied (that would re-bill the cancelled upgrade).
 *
 * Also pins:
 *   - the actor threading (admin user id + offline requestId reach the audit),
 *   - the no-pending-row no-op (same-tier renewal),
 *   - the happy-path transition + audit under the OFFLINE actor,
 *   - the swallow-only discipline (a repo throw is logged + swallowed, never
 *     re-thrown — the caller's payment is already durable; this is WHY the
 *     mark-paid-offline OUTER catch is belt-and-braces, not the primary guard).
 *
 * Pure Application — port interfaces only; metrics + logger stubbed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { finaliseF2PlanChangeOnPaid } from '@/modules/renewals/application/use-cases/finalise-f2-plan-change-on-paid';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import { asSatang } from '@/lib/money';

const { f2FinaliseBeforeF4CommitMock, loggerErrorMock } = vi.hoisted(() => ({
  f2FinaliseBeforeF4CommitMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    renewalsMetrics: {
      ...actual.renewalsMetrics,
      f2FinaliseBeforeF4Commit: f2FinaliseBeforeF4CommitMock,
    },
  };
});

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    logger: { ...actual.logger, error: loggerErrorMock },
  };
});

const TENANT_ID = 'tenantA';
const CYCLE_ID = '00000000-0000-0000-0000-0000000000c4';
const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
// A linkable suggestion id — the `tier_upgrade_accepted:<UUID>` reason prefix
// requires a valid UUID suffix (parseSuggestionIdFromReason rejects non-UUID).
const LINKED_SUGGESTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// 070 Item D OFFLINE actor — the admin's user id + the offline-mark requestId
// (NOT the `'system:f8-on-paid-webhook'` online sentinel).
const OFFLINE_ACTOR = {
  actorUserId: 'admin-1',
  requestId: `mark-paid-offline:${CYCLE_ID}`,
} as const;

function buildEvent(): F4InvoicePaidEvent {
  return {
    tenantId: TENANT_ID,
    invoiceId: INVOICE_ID,
    memberId: MEMBER_ID,
    paidAt: '2026-05-15T10:00:00Z',
    amountSatang: asSatang(5_000_000n),
    vatSatang: asSatang(350_000n),
    currency: 'THB',
    paymentMethod: 'bank_transfer',
    triggeredBy: 'admin_offline_mark',
  };
}

interface FakeDepsResult {
  deps: RenewalsDeps;
  findPendingMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  findByIdMock: ReturnType<typeof vi.fn>;
  recordMock: ReturnType<typeof vi.fn>;
}

function fakeDeps(): FakeDepsResult {
  // Default: no pending F2 row (the common same-tier-renewal no-op). Tests
  // override `findPendingMock` to drive the pending-row scenarios.
  const findPendingMock = vi.fn(async () => null);
  const transitionMock = vi.fn(async (_tenant, scheduledChangeId, status) => ({
    tenantId: TENANT_ID,
    scheduledChangeId,
    memberId: MEMBER_ID,
    effectiveAtCycleId: CYCLE_ID,
    fromPlanId: 'regular',
    toPlanId: 'premium',
    scheduledByUserId: 'admin-1',
    reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
    status,
    scheduledAt: '2026-05-01T00:00:00Z',
    appliedAt: '2026-05-15T10:00:00Z',
    supersededAt: null,
    cancelledAt: null,
  }));
  // Default: the linked suggestion resolves `applied` (normal accepted-then-
  // paid) → the per-row gate is OPEN. Per-test override drives `superseded`.
  const findByIdMock = vi.fn(async () => ({ status: 'applied' as const }));
  const recordMock = vi.fn(async () => ({ ok: true as const, value: undefined }));

  const deps = {
    tenant: { slug: TENANT_ID },
    scheduledPlanChangeRepo: {
      findPendingForCycle: findPendingMock,
      transitionStatus: transitionMock,
    },
    tierUpgradeRepo: {
      findById: findByIdMock,
    },
    f2AuditEmitter: {
      record: recordMock,
    },
  } as unknown as RenewalsDeps;

  return { deps, findPendingMock, transitionMock, findByIdMock, recordMock };
}

const PENDING_ROW = {
  tenantId: TENANT_ID,
  scheduledChangeId: 'sched-1',
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  fromPlanId: 'regular',
  toPlanId: 'premium',
  scheduledByUserId: 'admin-1',
  reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
  status: 'pending' as const,
  scheduledAt: '2026-05-01T00:00:00Z',
  appliedAt: null,
  supersededAt: null,
  cancelledAt: null,
};

describe('finaliseF2PlanChangeOnPaid (070 I1) — OFFLINE actor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('S6 money-safety — SKIPS the transition when the pending row\'s OWN linked suggestion is SUPERSEDED (no re-bill of a cancelled upgrade)', async () => {
    const { deps, findPendingMock, findByIdMock, transitionMock, recordMock } =
      fakeDeps();
    // A pending F2 row IS present (the supersede missed it) linked to the
    // superseded suggestion — flipping it → applied is the S6 re-bill bug.
    findPendingMock.mockResolvedValueOnce(PENDING_ROW);
    findByIdMock.mockResolvedValueOnce({ status: 'superseded' });

    await finaliseF2PlanChangeOnPaid(deps, buildEvent(), CYCLE_ID, OFFLINE_ACTOR);

    // The per-row gate resolved the linked suggestion by id (from the reason).
    expect(findByIdMock).toHaveBeenCalledWith(TENANT_ID, LINKED_SUGGESTION_ID);
    // SKIP: no transition, no audit, no counter — the orphan stays `pending`.
    expect(transitionMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(f2FinaliseBeforeF4CommitMock).not.toHaveBeenCalled();
  });

  it('no pending F2 row → clean no-op (same-tier renewal): no findById, no transition, no audit', async () => {
    const { deps, findPendingMock, findByIdMock, transitionMock, recordMock } =
      fakeDeps();
    // Default findPendingMock already returns null, but pin it explicitly.
    findPendingMock.mockResolvedValueOnce(null);

    await finaliseF2PlanChangeOnPaid(deps, buildEvent(), CYCLE_ID, OFFLINE_ACTOR);

    expect(findPendingMock).toHaveBeenCalledTimes(1);
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(transitionMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(f2FinaliseBeforeF4CommitMock).not.toHaveBeenCalled();
  });

  it('linked suggestion APPLIED (not superseded) → flips pending → applied + emits plan_change_applied under the OFFLINE admin actor', async () => {
    const { deps, findPendingMock, transitionMock, recordMock } = fakeDeps();
    findPendingMock.mockResolvedValueOnce(PENDING_ROW);
    // findByIdMock default resolves `applied` → per-row gate OPEN.

    await finaliseF2PlanChangeOnPaid(deps, buildEvent(), CYCLE_ID, OFFLINE_ACTOR);

    // Counter bumped exactly once (inside the finaliser, after the gate).
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledWith(TENANT_ID);
    // pending → applied.
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![2]).toBe('applied');
    // Audit recorded under the OFFLINE actor (admin user id + offline reqId).
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [ctx, event] = recordMock.mock.calls[0]!;
    expect((ctx as { actorUserId?: string }).actorUserId).toBe('admin-1');
    expect((ctx as { requestId?: string }).requestId).toBe(
      `mark-paid-offline:${CYCLE_ID}`,
    );
    expect((event as { event_type?: string }).event_type).toBe(
      'plan_change_applied',
    );
    expect((event as { payload: { applied_at_invoice_id: string } }).payload
      .applied_at_invoice_id).toBe(INVOICE_ID);
  });

  it('standalone schedule (reason has no tier_upgrade_accepted: prefix) → proceeds WITHOUT a findById lookup', async () => {
    const { deps, findPendingMock, findByIdMock, transitionMock, recordMock } =
      fakeDeps();
    findPendingMock.mockResolvedValueOnce({
      ...PENDING_ROW,
      reason: 'admin_manual_schedule',
    });

    await finaliseF2PlanChangeOnPaid(deps, buildEvent(), CYCLE_ID, OFFLINE_ACTOR);

    // No suggestion link → no findById, but the finaliser proceeds.
    expect(findByIdMock).not.toHaveBeenCalled();
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('swallow-only discipline — a findPendingForCycle THROW is logged + swallowed (NOT re-thrown), so the caller payment stays durable', async () => {
    const { deps, findPendingMock, transitionMock } = fakeDeps();
    findPendingMock.mockRejectedValueOnce(new Error('db read failed post-commit'));

    // The helper must resolve (not reject) — its internal try/catch swallows.
    await expect(
      finaliseF2PlanChangeOnPaid(deps, buildEvent(), CYCLE_ID, OFFLINE_ACTOR),
    ).resolves.toBeUndefined();

    expect(transitionMock).not.toHaveBeenCalled();
    // The find-pending failure is logged with the stable errorId for replay.
    const log = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { errorId?: string } | undefined)?.errorId ===
        'F2.PLAN_CHANGE.FIND_PENDING_FAILED',
    );
    expect(log).toBeDefined();
  });
});
