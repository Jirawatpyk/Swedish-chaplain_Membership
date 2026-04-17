import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getPlan,
  type GetPlanInput,
  type GetPlanDeps,
} from '@/modules/plans/application/get-plan';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';

const tenant = asTenantContext('swecham');
const planId = asPlanSlug('corporate-standard');
const year = asPlanYear(2026);
const NOW = new Date('2026-04-17T10:00:00.000Z');

const baseInput: GetPlanInput = { planId, year };

function makePlan(): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: planId,
    plan_year: year,
    plan_name: { en: 'Corporate Standard' },
    description: { en: 'Desc' },
    sort_order: 1,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 5_000_000,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: {},
    is_active: true,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'seed',
    updated_by: 'seed',
  } as unknown as Plan;
}

function makeDeps(overrides: {
  findOneResult?: Plan | undefined | Error;
  auditFail?: boolean;
} = {}): GetPlanDeps {
  return {
    tenant,
    planRepo: {
      findOne: vi.fn(async () => {
        const r = overrides.findOneResult;
        if (r instanceof Error) throw r;
        return r;
      }),
      findByTenantAndYear: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      softDelete: vi.fn(),
      undelete: vi.fn(),
      cloneYear: vi.fn(),
      countActiveForTenant: vi.fn(),
    },
    audit: {
      record: vi.fn(async () => {
        if (overrides.auditFail) return err({ type: 'persist_failed' as const, message: 'fail' });
        return ok(undefined as void);
      }),
    },
    actorUserId: 'actor-uuid',
    requestId: 'req-001',
    sourceIp: '10.0.0.1',
    method: 'GET',
    route: '/api/plans/corporate-standard/2026',
  } as unknown as GetPlanDeps;
}

describe('getPlan use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when planRepo.findOne throws', async () => {
    const deps = makeDeps({ findOneResult: new Error('DB timeout') });
    const result = await getPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') expect(result.error.message).toBe('DB timeout');
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns server_error with string coercion for non-Error throws', async () => {
    const deps = makeDeps();
    (deps.planRepo.findOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce('raw string error');
    const result = await getPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns not_found when plan missing and fires plan_not_found audit', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    const result = await getPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.event_type).toBe('plan_not_found');
    expect(event.payload.requested_plan_id).toBe(planId);
  });

  it('returns not_found even when plan_not_found audit fails (non-fatal)', async () => {
    const deps = makeDeps({ findOneResult: undefined, auditFail: true });
    const result = await getPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns ok(plan) on success without calling audit', async () => {
    const plan = makePlan();
    const deps = makeDeps({ findOneResult: plan });
    const result = await getPlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(plan);
    expect(deps.audit.record).not.toHaveBeenCalled();
  });
});
