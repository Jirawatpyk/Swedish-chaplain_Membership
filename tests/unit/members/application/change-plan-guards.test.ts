/**
 * 126 (#4, #5, #9, #10) — `changePlan` guards.
 *
 *   #4  an archived member is refused (pre-tx snapshot AND the FOR UPDATE
 *       re-read) — inline-edit already refused it.
 *   #5  the primary contact's age and the member's legal entity type are
 *       checked against the new plan (`maxMemberAge`, `memberTypeScope`).
 *   #9  leaving a partnership bundle needs confirmation, not only entering one.
 *   #10 the post-commit listener catch logs `errKind(e)`, never `e.message`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import { logger } from '@/lib/logger';
import { changePlan, type ChangePlanDeps } from '@/modules/members/application/use-cases/change-plan';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-126' };

function member(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: tenant.slug,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: 'limited_company',
    foundedYear: null,
    turnoverThb: null,
    planId: asPlanId('plan-old'),
    planYear: 2026,
    registrationDate: new Date('2020-01-01'),
    status: 'active',
    archivedAt: null,
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: tenant.slug,
    planId: asPlanId('plan-new'),
    planYear: 2026,
    planNameEn: 'New',
    planCategory: 'corporate',
    memberTypeScope: 'company',
    minTurnoverThb: null,
    maxTurnoverThb: null,
    maxDurationYears: null,
    maxMemberAge: null,
    includesCorporatePlanId: null,
    isSoftDeleted: false,
    ...overrides,
  };
}

function buildDeps(opts: {
  current?: ReturnType<typeof member>;
  locked?: ReturnType<typeof member>;
  oldPlan?: ReturnType<typeof plan>;
  newPlan?: ReturnType<typeof plan>;
  primaryDob?: Date | null;
  listeners?: Array<(e: unknown) => Promise<void>>;
}) {
  const current = opts.current ?? member();
  const oldPlan = opts.oldPlan ?? plan({ planId: asPlanId('plan-old') });
  const newPlan = opts.newPlan ?? plan();
  const deps = {
    tenant,
    clock: { now: () => new Date('2026-10-24T00:00:00Z') },
    memberRepo: {
      findById: vi.fn().mockResolvedValue(ok(current)),
      findByIdInTx: vi.fn().mockResolvedValue(ok(opts.locked ?? current)),
      updateFieldsInTx: vi.fn().mockResolvedValue(ok(member({ planId: asPlanId('plan-new') }))),
    },
    contactRepo: {
      listByMember: vi.fn().mockResolvedValue(
        ok([
          { contactId: 'c1', isPrimary: true, removedAt: null, dateOfBirth: opts.primaryDob ?? null },
        ]),
      ),
    },
    plans: {
      getPlan: vi.fn(async (_t: unknown, id: string) => ok(id === 'plan-old' ? oldPlan : newPlan)),
    },
    audit: { record: vi.fn(), recordInTx: vi.fn().mockResolvedValue(ok(undefined)) },
    planAdvisoryLock: {
      acquire: vi.fn().mockResolvedValue(undefined),
      isPlanSoftDeletedInTx: vi.fn().mockResolvedValue(false),
    },
    manualPlanChangeListeners: opts.listeners ?? [],
  };
  return deps as unknown as ChangePlanDeps & typeof deps;
}

const BODY = { new_plan_id: 'plan-new', new_plan_year: 2026 };

describe('changePlan guards (126)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('#4 refuses an archived member before any write', async () => {
    const deps = buildDeps({ current: member({ status: 'archived', archivedAt: new Date() }) });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('#4 refuses when the member was archived after the pre-tx read (locked row)', async () => {
    const deps = buildDeps({ locked: member({ status: 'archived', archivedAt: new Date() }) });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('#5 refuses a primary contact over the new plan max age', async () => {
    const deps = buildDeps({
      newPlan: plan({ maxMemberAge: 35 }),
      primaryDob: new Date('1980-01-01T00:00:00Z'),
    });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r).toEqual({
      ok: false,
      error: { type: 'age_not_eligible', ageYears: 46, maxAge: 35 },
    });
  });

  it('#5 refuses an individual member on a company-only plan', async () => {
    const deps = buildDeps({ current: member({ legalEntityType: 'individual' }) });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('member_type_out_of_scope');
  });

  it('#9 asks for confirmation when leaving a partnership bundle', async () => {
    const deps = buildDeps({
      oldPlan: plan({
        planId: asPlanId('plan-old'),
        planCategory: 'partnership',
        includesCorporatePlanId: asPlanId('corp-large'),
      }),
    });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('bundle_change_requires_confirmation');
  });

  it('#10 logs the listener failure as errKind, never the message', async () => {
    const deps = buildDeps({
      listeners: [
        async () => {
          throw new TypeError('member anna@example.com has no cycle');
        },
      ],
    });
    const r = await changePlan(memberId, BODY, meta, deps);
    expect(r.ok).toBe(true);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'TypeError' }),
      expect.any(String),
    );
  });
});
