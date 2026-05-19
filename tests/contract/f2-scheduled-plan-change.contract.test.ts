/**
 * T015 (F8 Phase 2 Wave B) — Contract test for F2 scheduled-plan-change
 * use-cases (`scheduleNextRenewalPlanChange` + `getEffectivePlanForRenewal`).
 *
 * Pinned contracts — the `scheduled_plan_changes` table itself ships in
 * Wave C (migration 0086), so this contract test mocks the
 * `ScheduledPlanChangeRepo` port with an in-memory store. The repo
 * adapter (Drizzle) lands in Phase 5+ when US5 wires the F4 hook.
 *
 * Six contracts pinned here:
 *
 *   1. `scheduleNextRenewalPlanChange` happy path — schedule inserts a
 *      `pending` row with all caller-supplied fields preserved + Domain
 *      defaults.
 *
 *   2. Supersede — re-scheduling on the same (member, cycle) flips the
 *      prior `pending` row to `superseded` and inserts a fresh
 *      `pending` row. NOT a delete + insert (audit trail preserved).
 *
 *   3. Tenant scope — repo always receives the caller's `TenantContext`;
 *      a use-case that drops it should fail at compile time (asserted
 *      indirectly by passing the tenant + verifying the spy receives it).
 *
 *   4. `getEffectivePlanForRenewal` — when a `pending` row exists for
 *      the (member, cycle), return its `to_plan_id`. When NO pending
 *      row exists, return the member's CURRENT plan via the
 *      `currentPlanResolver` port (callback into F2's existing
 *      `getPlanForMember`).
 *
 *   5. Terminal-state safety — `getEffectivePlanForRenewal` ignores rows
 *      in terminal states (`applied`, `superseded`, `cancelled`) and
 *      falls through to the current-plan resolver.
 *
 *   6. Schedule on a member that already has an `applied` row (terminal)
 *      for the SAME cycle — does NOT supersede the terminal row;
 *      inserts a fresh `pending` row alongside (data-model.md § 2.9
 *      partial unique permits multiple terminal rows + at most one
 *      pending per cycle).
 *
 * Test style: in-memory repo. No live DB. The contract is at the
 * Application boundary; the Drizzle adapter (Wave C+) will be covered
 * by an integration test that verifies the partial unique enforces
 * the `at most one pending` invariant at the DB layer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok } from '@/lib/result';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import {
  scheduleNextRenewalPlanChange,
  getEffectivePlanForRenewal,
  type AuditPort,
  type ScheduledPlanChange,
  type ScheduledPlanChangeRepo,
  type ScheduledPlanChangeStatus,
  type CurrentPlanResolverPort,
} from '@/modules/plans';

// Post-ship R6 I2 — stub AuditPort (always succeeds). The contract
// test asserts repo behaviour; audit-emit branch coverage lives in
// the unit suite (`tests/unit/plans/application/...`).
const stubAudit: AuditPort = {
  record: vi.fn(async () => ok(undefined as void)),
};

// ── In-memory repo helpers ────────────────────────────────────────────────────

// Mutable mirror so the in-memory repo can flip readonly fields to
// simulate the Drizzle adapter's UPDATE behaviour without `as any` casts.
type MutableScheduledPlanChange = {
  -readonly [K in keyof ScheduledPlanChange]: ScheduledPlanChange[K];
};

function makeMemoryRepo(seed: ScheduledPlanChange[] = []): ScheduledPlanChangeRepo {
  const rows: MutableScheduledPlanChange[] = seed.map((r) => ({ ...r }));

  return {
    // Wave B verify-run F1 remediation — atomic supersede+insert.
    // The mock is synchronous + can't fail mid-pair, but the contract
    // assertion below (Contract 7) verifies the result shape returned
    // to the use-case is faithful to the SupersedeAndInsertResult type
    // so the Drizzle adapter (Phase 5+) ships against the same contract.
    supersedeAndInsertPendingAtomically: vi.fn(async (ctx, input) => {
      const prior = rows.find(
        (r) =>
          r.tenantId === ctx.slug &&
          r.memberId === input.memberId &&
          r.effectiveAtCycleId === input.effectiveAtCycleId &&
          r.status === 'pending',
      );
      let supersededRow: ScheduledPlanChange | null = null;
      if (prior) {
        prior.status = 'superseded';
        prior.supersededAt = '2026-05-03T12:05:00Z';
        supersededRow = prior;
      }
      const insertedRow: MutableScheduledPlanChange = {
        tenantId: ctx.slug,
        scheduledChangeId: `mem-${rows.length + 1}`,
        memberId: input.memberId,
        effectiveAtCycleId: input.effectiveAtCycleId,
        fromPlanId: input.fromPlanId,
        toPlanId: input.toPlanId,
        scheduledByUserId: input.scheduledByUserId,
        reason: input.reason ?? null,
        status: 'pending',
        scheduledAt: '2026-05-03T12:00:00Z',
        appliedAt: null,
        supersededAt: null,
        cancelledAt: null,
      };
      rows.push(insertedRow);
      return { inserted: insertedRow, superseded: supersededRow };
    }),
    findPendingForCycle: vi.fn(async (ctx, memberId, cycleId) => {
      return (
        rows.find(
          (r) =>
            r.tenantId === ctx.slug &&
            r.memberId === memberId &&
            r.effectiveAtCycleId === cycleId &&
            r.status === 'pending',
        ) ?? null
      );
    }),
    // R2 Batch 3g (R2-I16) — primary-key lookup.
    findById: vi.fn(async (ctx, scheduledChangeId) => {
      return (
        rows.find(
          (r) =>
            r.tenantId === ctx.slug &&
            r.scheduledChangeId === scheduledChangeId,
        ) ?? null
      );
    }),
    transitionStatus: vi.fn(async (ctx, scheduledChangeId, nextStatus) => {
      const row = rows.find(
        (r) =>
          r.tenantId === ctx.slug && r.scheduledChangeId === scheduledChangeId,
      );
      if (!row) throw new Error(`row not found: ${scheduledChangeId}`);
      if (row.status !== 'pending') {
        throw new Error(
          `cannot transition from terminal status ${row.status} → ${nextStatus}`,
        );
      }
      row.status = nextStatus;
      const now = '2026-05-03T12:05:00Z';
      if (nextStatus === 'applied') row.appliedAt = now;
      if (nextStatus === 'superseded') row.supersededAt = now;
      if (nextStatus === 'cancelled') row.cancelledAt = now;
      return row;
    }),
    listForMember: vi.fn(async (ctx, memberId) =>
      rows.filter((r) => r.tenantId === ctx.slug && r.memberId === memberId),
    ),
  };
}

const tenant: TenantContext = asTenantContext('test-swecham');
const MEMBER_ID = '00000000-0000-0000-0000-0000000000a1';
const CYCLE_ID = '00000000-0000-0000-0000-0000000000c1';
const ADMIN_USER_ID = '00000000-0000-0000-0000-0000000000aa';

describe('Contract — F2 scheduleNextRenewalPlanChange', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Contract 1 ────────────────────────────────────────────────────
  it('Contract 1: happy path — inserts pending row with caller-supplied fields preserved', async () => {
    const repo = makeMemoryRepo();
    const r = await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: ADMIN_USER_ID,
        reason: 'tier upgrade accepted by member',
      },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('pending');
    expect(r.value.fromPlanId).toBe('corporate-regular');
    expect(r.value.toPlanId).toBe('corporate-premier');
    expect(r.value.scheduledByUserId).toBe(ADMIN_USER_ID);
    expect(r.value.reason).toBe('tier upgrade accepted by member');
    expect(r.value.tenantId).toBe('test-swecham');
    expect(repo.supersedeAndInsertPendingAtomically).toHaveBeenCalledTimes(1);
  });

  // ── Contract 2 ────────────────────────────────────────────────────
  it('Contract 2: supersede — re-schedule flips prior pending → superseded and inserts new pending', async () => {
    const repo = makeMemoryRepo();
    // First schedule
    await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );
    // Re-schedule with a different toPlanId on the SAME (member, cycle)
    const r2 = await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-elite',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );

    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.toPlanId).toBe('corporate-elite');
    expect(r2.value.status).toBe('pending');

    // Audit trail must include both rows. Prior must now be 'superseded'.
    const all = await repo.listForMember(tenant, MEMBER_ID);
    expect(all.length).toBe(2);
    const statuses = all.map((r) => r.status).sort();
    expect(statuses).toEqual(['pending', 'superseded']);
    const supersededRow = all.find((r) => r.status === 'superseded');
    expect(supersededRow?.toPlanId).toBe('corporate-premier');
  });

  // ── Contract 3 ────────────────────────────────────────────────────
  it('Contract 3: tenant scope — repo always receives the caller TenantContext (compile-enforced)', async () => {
    const repo = makeMemoryRepo();
    await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'p-from',
        toPlanId: 'p-to',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );
    expect(repo.supersedeAndInsertPendingAtomically).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'test-swecham' }),
      expect.any(Object),
    );
  });

  // ── Contract 7 (added at /speckit.verify.run Wave B F1 remediation) ────
  it('Contract 7: atomic shape — repo returns {inserted, superseded} so caller never observes a "no pending" intermediate state (Constitution Principle VIII)', async () => {
    const repo = makeMemoryRepo();
    // First schedule — superseded should be null (no prior pending row).
    await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );
    expect(repo.supersedeAndInsertPendingAtomically).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: 'test-swecham' }),
      expect.objectContaining({ toPlanId: 'corporate-premier' }),
    );
    const firstResult = await (
      repo.supersedeAndInsertPendingAtomically as ReturnType<typeof vi.fn>
    ).mock.results[0]?.value;
    expect(firstResult.inserted).toBeDefined();
    expect(firstResult.inserted.status).toBe('pending');
    expect(firstResult.superseded).toBeNull();

    // Second schedule on same (member, cycle) — superseded surfaces the prior pending row.
    await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-elite',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );
    const secondResult = await (
      repo.supersedeAndInsertPendingAtomically as ReturnType<typeof vi.fn>
    ).mock.results[1]?.value;
    expect(secondResult.inserted.status).toBe('pending');
    expect(secondResult.inserted.toPlanId).toBe('corporate-elite');
    expect(secondResult.superseded).not.toBeNull();
    expect(secondResult.superseded.status).toBe('superseded');
    expect(secondResult.superseded.toPlanId).toBe('corporate-premier');
  });
});

describe('Contract — F2 getEffectivePlanForRenewal', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Contract 4 ────────────────────────────────────────────────────
  it('Contract 4: returns scheduled plan when a pending row exists for the cycle', async () => {
    const seed: ScheduledPlanChange[] = [
      {
        tenantId: 'test-swecham',
        scheduledChangeId: 's1',
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: ADMIN_USER_ID,
        reason: null,
        status: 'pending',
        scheduledAt: '2026-05-03T12:00:00Z',
        appliedAt: null,
        supersededAt: null,
        cancelledAt: null,
      },
    ];
    const repo = makeMemoryRepo(seed);
    const currentPlanResolver: CurrentPlanResolverPort = {
      resolveCurrentPlanId: vi.fn(async () => 'corporate-regular'),
    };

    const r = await getEffectivePlanForRenewal(
      { tenant, repo, currentPlanResolver },
      { memberId: MEMBER_ID, cycleId: CYCLE_ID },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.planId).toBe('corporate-premier');
    expect(r.value.source).toBe('scheduled');
    // Did NOT need to fall through to currentPlanResolver
    expect(currentPlanResolver.resolveCurrentPlanId).not.toHaveBeenCalled();
  });

  it('Contract 4 (fallthrough): returns current plan when NO pending row exists', async () => {
    const repo = makeMemoryRepo();
    const currentPlanResolver: CurrentPlanResolverPort = {
      resolveCurrentPlanId: vi.fn(async () => 'corporate-regular'),
    };

    const r = await getEffectivePlanForRenewal(
      { tenant, repo, currentPlanResolver },
      { memberId: MEMBER_ID, cycleId: CYCLE_ID },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.planId).toBe('corporate-regular');
    expect(r.value.source).toBe('current');
    expect(currentPlanResolver.resolveCurrentPlanId).toHaveBeenCalledWith(
      tenant,
      MEMBER_ID,
    );
  });

  // ── Contract 5 ────────────────────────────────────────────────────
  it('Contract 5: terminal-status safety — applied/superseded/cancelled rows are ignored, falls through to current plan', async () => {
    const terminalStatuses: ScheduledPlanChangeStatus[] = [
      'applied',
      'superseded',
      'cancelled',
    ];
    for (const status of terminalStatuses) {
      const seed: ScheduledPlanChange[] = [
        {
          tenantId: 'test-swecham',
          scheduledChangeId: `term-${status}`,
          memberId: MEMBER_ID,
          effectiveAtCycleId: CYCLE_ID,
          fromPlanId: 'corporate-regular',
          toPlanId: 'corporate-premier',
          scheduledByUserId: ADMIN_USER_ID,
          reason: null,
          status,
          scheduledAt: '2026-05-03T12:00:00Z',
          appliedAt: status === 'applied' ? '2026-05-03T12:01:00Z' : null,
          supersededAt: status === 'superseded' ? '2026-05-03T12:01:00Z' : null,
          cancelledAt: status === 'cancelled' ? '2026-05-03T12:01:00Z' : null,
        },
      ];
      const repo = makeMemoryRepo(seed);
      const currentPlanResolver: CurrentPlanResolverPort = {
        resolveCurrentPlanId: vi.fn(async () => 'corporate-regular'),
      };

      const r = await getEffectivePlanForRenewal(
        { tenant, repo, currentPlanResolver },
        { memberId: MEMBER_ID, cycleId: CYCLE_ID },
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.planId, `terminal=${status}`).toBe('corporate-regular');
      expect(r.value.source, `terminal=${status}`).toBe('current');
    }
  });
});

describe('Contract — Terminal coexistence (Contract 6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Contract 6: scheduling after a terminal row exists for same cycle — inserts new pending alongside (no supersede of terminal)', async () => {
    const seed: ScheduledPlanChange[] = [
      {
        tenantId: 'test-swecham',
        scheduledChangeId: 's-applied',
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-regular',
        toPlanId: 'corporate-premier',
        scheduledByUserId: ADMIN_USER_ID,
        reason: null,
        status: 'applied',
        scheduledAt: '2026-05-01T12:00:00Z',
        appliedAt: '2026-05-02T12:00:00Z',
        supersededAt: null,
        cancelledAt: null,
      },
    ];
    const repo = makeMemoryRepo(seed);

    const r = await scheduleNextRenewalPlanChange(
      {
        tenant,
        repo,
        audit: stubAudit,
        actorUserId: ADMIN_USER_ID,
        requestId: 'req-test',
        sourceIp: null,
      },
      {
        memberId: MEMBER_ID,
        effectiveAtCycleId: CYCLE_ID,
        fromPlanId: 'corporate-premier',
        toPlanId: 'corporate-elite',
        scheduledByUserId: ADMIN_USER_ID,
      },
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = await repo.listForMember(tenant, MEMBER_ID);
    expect(all.length).toBe(2);
    const statuses = all.map((row) => row.status).sort();
    expect(statuses).toEqual(['applied', 'pending']);
    // Terminal row stays untouched
    const terminal = all.find((row) => row.scheduledChangeId === 's-applied');
    expect(terminal?.status).toBe('applied');
  });
});
