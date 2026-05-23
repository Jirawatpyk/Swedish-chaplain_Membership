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
