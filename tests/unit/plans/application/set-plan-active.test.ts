import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  activatePlan,
  type ActivatePlanInput,
  type ActivatePlanDeps,
} from '@/modules/plans/application/activate-plan';
import {
  deactivatePlan,
  type DeactivatePlanInput,
  type DeactivatePlanDeps,
} from '@/modules/plans/application/deactivate-plan';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';

const tenant = asTenantContext('swecham');
const planId = asPlanSlug('corporate-standard');
const year = asPlanYear(2026);
const NOW = new Date('2026-04-17T10:00:00.000Z');

const baseInput: ActivatePlanInput = {
  planId,
  year,
  actorUserId: 'actor-uuid',
  requestId: 'req-001',
  sourceIp: '10.0.0.1',
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: planId,
    plan_year: year,
    plan_name: { en: 'Corporate Standard', th: 'มาตรฐาน', sv: 'Standard' },
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
    is_active: false,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'seed',
    updated_by: 'seed',
    ...overrides,
  } as unknown as Plan;
}

type DepsOverrides = {
  findOneResult?: Plan | undefined | Error;
  setActiveResult?: Plan | undefined | Error;
  auditFail?: 'persist_failed' | 'invalid_payload';
};

function makeDeps(overrides: DepsOverrides = {}): ActivatePlanDeps {
  const planRepo = {
    findOne: vi.fn(async () => {
      const r = overrides.findOneResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    setActive: vi.fn(async () => {
      const r = overrides.setActiveResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    findByTenantAndYear: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(),
    countActiveForTenant: vi.fn(),
  };

  const audit = {
    record: vi.fn(async () => {
      if (overrides.auditFail === 'persist_failed') {
        return err({ type: 'persist_failed' as const, message: 'write error' });
      }
      if (overrides.auditFail === 'invalid_payload') {
        return err({ type: 'invalid_payload' as const, issues: ['bad field'] as readonly string[] });
      }
      return ok(undefined as void);
    }),
  };

  return {
    tenant,
    planRepo,
    feeConfigRepo: { findByTenant: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    audit,
    clock: { now: vi.fn(() => NOW), currentYear: vi.fn(() => 2026) },
    members: { countActivePlanMembers: vi.fn(async () => 0) },
  } as unknown as ActivatePlanDeps;
}

describe('activatePlan use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when planRepo.findOne throws', async () => {
    const deps = makeDeps({ findOneResult: new Error('DB down') });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns not_found when planRepo.findOne returns undefined', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns not_found when plan is soft-deleted', async () => {
    const deps = makeDeps({ findOneResult: makePlan({ deleted_at: NOW }) });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns ok idempotently when plan is already active', async () => {
    const activePlan = makePlan({ is_active: true });
    const deps = makeDeps({ findOneResult: activePlan });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(activePlan);
    expect(deps.planRepo.setActive).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns server_error when planRepo.setActive throws', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: false }),
      setActiveResult: new Error('setActive fail'),
    });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns not_found when planRepo.setActive returns undefined', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: false }),
      setActiveResult: undefined,
    });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns audit_failed on persist_failed audit', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: false }),
      setActiveResult: makePlan({ is_active: true }),
      auditFail: 'persist_failed',
    });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') expect(result.error.message).toBe('write error');
    }
  });

  it('returns audit_failed with joined issues on invalid_payload', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: false }),
      setActiveResult: makePlan({ is_active: true }),
      auditFail: 'invalid_payload',
    });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') expect(result.error.message).toBe('bad field');
    }
  });

  it('returns ok with updated plan and records plan_activated audit', async () => {
    const updated = makePlan({ is_active: true });
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: false }),
      setActiveResult: updated,
    });
    const result = await activatePlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(updated);
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.event_type).toBe('plan_activated');
    expect(event.payload.diff.is_active).toEqual({ before: false, after: true });
  });
});

describe('deactivatePlan use case', () => {
  beforeEach(() => vi.clearAllMocks());

  const deactivateInput: DeactivatePlanInput = { ...baseInput };

  it('returns not_found when plan missing', async () => {
    const deps = makeDeps({ findOneResult: undefined }) as unknown as DeactivatePlanDeps;
    const result = await deactivatePlan(deactivateInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
  });

  it('returns ok idempotently when already inactive', async () => {
    const inactivePlan = makePlan({ is_active: false });
    const deps = makeDeps({ findOneResult: inactivePlan }) as unknown as DeactivatePlanDeps;
    const result = await deactivatePlan(deactivateInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(inactivePlan);
    expect(deps.planRepo.setActive).not.toHaveBeenCalled();
  });

  it('records plan_deactivated audit on success', async () => {
    const updated = makePlan({ is_active: false });
    const deps = makeDeps({
      findOneResult: makePlan({ is_active: true }),
      setActiveResult: updated,
    }) as unknown as DeactivatePlanDeps;
    const result = await deactivatePlan(deactivateInput, deps);
    expect(result.ok).toBe(true);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.event_type).toBe('plan_deactivated');
    expect(event.payload.diff.is_active).toEqual({ before: true, after: false });
  });
});
