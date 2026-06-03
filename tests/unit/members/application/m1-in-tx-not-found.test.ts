/**
 * M1 (round-1 hardening) added an in-transaction `findByIdInTx` (SELECT ...
 * FOR UPDATE) to `updateMember` and `changePlan` so the diff base is read
 * inside the write tx (closing the TOCTOU stale-audit-diff window). That move
 * introduced a NEW branch: the member can be deleted between the pre-tx
 * validation read and the in-tx locked re-read → the locked read returns
 * `repo.not_found` → the use-case must surface `{ type: 'not_found' }`.
 *
 * Round-2 review gap: that branch had no use-case-level coverage (the contract
 * tests mock the whole use-case). This suite locks it with stubbed deps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — invoke the callback with a dummy tx, re-throw what it throws.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { updateMember } from '@/modules/members/application/use-cases/update-member';
import type { UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import { changePlan } from '@/modules/members/application/use-cases/change-plan';
import type { ChangePlanDeps } from '@/modules/members/application/use-cases/change-plan';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-m1' };

function baseMember() {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: 2020,
    turnoverThb: null,
    planId: asPlanId('plan-1'),
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: true,
    lastActivityAt: null,
    notes: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('M1 — updateMember surfaces not_found when the in-tx locked read misses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('findByIdInTx → repo.not_found ⇒ { type: not_found }', async () => {
    const deps = {
      tenant,
      memberRepo: {
        findByIdInTx: vi.fn().mockResolvedValue(err({ code: 'repo.not_found' as const })),
        updateFieldsInTx: vi.fn(),
      } as unknown as UpdateMemberDeps['memberRepo'],
      audit: { record: vi.fn(), recordInTx: vi.fn() },
      clock: { now: () => new Date('2026-05-22') },
    } as unknown as UpdateMemberDeps;

    const result = await updateMember(memberId, { website: 'https://x.com' }, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    // The write must NOT be attempted once the locked read misses.
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });
});

describe('M1 — changePlan surfaces not_found when the in-tx locked read misses', () => {
  beforeEach(() => vi.clearAllMocks());

  it('findByIdInTx → repo.not_found ⇒ { type: not_found }', async () => {
    const corporatePlan = {
      tenantId: tenant.slug,
      planId: 'plan-2',
      planYear: 2026,
      planCategory: 'corporate' as const,
      memberTypeScope: 'company' as const,
      minTurnoverThb: null,
      maxTurnoverThb: null,
      maxDurationYears: null,
      includesCorporatePlanId: null,
      isSoftDeleted: false,
      annualFeeMinorUnits: 1_000_000,
      isActive: true,
    };
    const deps = {
      tenant,
      memberRepo: {
        // pre-tx validation read succeeds (member exists, on a DIFFERENT plan
        // so the no-op short-circuit is skipped)…
        findById: vi.fn().mockResolvedValue(ok(baseMember())),
        // …but the in-tx locked re-read misses (member deleted in the window).
        findByIdInTx: vi.fn().mockResolvedValue(err({ code: 'repo.not_found' as const })),
        updateFieldsInTx: vi.fn(),
      } as unknown as ChangePlanDeps['memberRepo'],
      plans: {
        getPlan: vi.fn().mockResolvedValue(ok(corporatePlan)),
      } as unknown as ChangePlanDeps['plans'],
      audit: { record: vi.fn(), recordInTx: vi.fn() },
      // W0-02: changePlan now acquires the soft-delete advisory lock at tx start
      // and re-checks the new plan's deletion state under the lock (code-review #1).
      planAdvisoryLock: {
        acquire: vi.fn().mockResolvedValue(undefined),
        isPlanSoftDeletedInTx: vi.fn().mockResolvedValue(false),
      },
    } as unknown as ChangePlanDeps;

    const result = await changePlan(
      memberId,
      { new_plan_id: 'plan-2', new_plan_year: 2026 },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });
});

// W0-02 completion (code-review #1) — a member must never be assigned to a
// soft-deleted plan. Two guards: a pre-tx fast-fail on the `getPlan` snapshot,
// and an in-tx re-check under the advisory lock that closes the race where the
// plan is soft-deleted between the snapshot and the FK write.
describe('changePlan refuses to assign a member to a soft-deleted plan', () => {
  beforeEach(() => vi.clearAllMocks());

  function planSummary(isSoftDeleted: boolean) {
    return {
      tenantId: tenant.slug,
      planId: 'plan-2',
      planYear: 2026,
      planNameEn: 'Gold',
      planCategory: 'corporate' as const,
      memberTypeScope: 'company' as const,
      minTurnoverThb: null,
      maxTurnoverThb: null,
      maxDurationYears: null,
      maxMemberAge: null,
      includesCorporatePlanId: null,
      isSoftDeleted,
    };
  }

  function changePlanDeps(opts: {
    snapshotSoftDeleted: boolean;
    inTxSoftDeleted: boolean;
  }) {
    const acquire = vi.fn().mockResolvedValue(undefined);
    const isPlanSoftDeletedInTx = vi
      .fn()
      .mockResolvedValue(opts.inTxSoftDeleted);
    const updateFieldsInTx = vi.fn();
    const deps = {
      tenant,
      memberRepo: {
        findById: vi.fn().mockResolvedValue(ok(baseMember())),
        findByIdInTx: vi.fn().mockResolvedValue(ok(baseMember())),
        updateFieldsInTx,
      } as unknown as ChangePlanDeps['memberRepo'],
      plans: {
        getPlan: vi
          .fn()
          .mockResolvedValue(ok(planSummary(opts.snapshotSoftDeleted))),
      } as unknown as ChangePlanDeps['plans'],
      audit: { record: vi.fn(), recordInTx: vi.fn().mockResolvedValue(ok(undefined)) },
      planAdvisoryLock: { acquire, isPlanSoftDeletedInTx },
    } as unknown as ChangePlanDeps;
    return { deps, acquire, isPlanSoftDeletedInTx, updateFieldsInTx };
  }

  it('pre-tx: snapshot says plan is soft-deleted ⇒ plan_not_found, tx never opened', async () => {
    const { deps, acquire, updateFieldsInTx } = changePlanDeps({
      snapshotSoftDeleted: true,
      inTxSoftDeleted: false,
    });
    const result = await changePlan(
      memberId,
      { new_plan_id: 'plan-2', new_plan_year: 2026 },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('plan_not_found');
    // Fast-fail before the tx — no lock, no write.
    expect(acquire).not.toHaveBeenCalled();
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('in-tx race: snapshot live but plan soft-deleted under the lock ⇒ plan_not_found, no FK write', async () => {
    const { deps, acquire, isPlanSoftDeletedInTx, updateFieldsInTx } =
      changePlanDeps({ snapshotSoftDeleted: false, inTxSoftDeleted: true });
    const result = await changePlan(
      memberId,
      { new_plan_id: 'plan-2', new_plan_year: 2026 },
      meta,
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('plan_not_found');
    // The lock was taken and the in-tx re-check ran BEFORE the FK write…
    expect(acquire).toHaveBeenCalledOnce();
    expect(isPlanSoftDeletedInTx).toHaveBeenCalledOnce();
    // …and the member FK was never written onto the soft-deleted plan.
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });
});
