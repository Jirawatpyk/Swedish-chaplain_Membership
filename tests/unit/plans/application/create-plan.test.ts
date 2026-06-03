import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createPlan,
  type CreatePlanInput,
  type CreatePlanDeps,
} from '@/modules/plans/application/create-plan';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';
import type { PlanSchemaInput } from '@/modules/plans/domain/plan-validators';

const tenant = asTenantContext('swecham');
const NOW = new Date('2026-04-17T10:00:00.000Z');

const validBenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: null,
  homepage_logo_category: null,
  directory_listing_size: null,
  event_discount_scope: 'none' as const,
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: false,
  business_referrals: false,
  tailor_made_services: false,
  partnership: null,
};

const validInput: PlanSchemaInput = {
  plan_id: 'corporate-standard',
  plan_year: 2026,
  plan_name: { en: 'Corporate Standard' },
  description: { en: 'Test description' },
  sort_order: 1,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 5_000_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: validBenefitMatrix,
};

const baseInput: CreatePlanInput = {
  input: validInput,
  actorUserId: 'actor-uuid',
  requestId: 'req-001',
  sourceIp: '10.0.0.1',
  idempotencyKey: 'idem-001',
};

function makePlan(): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: asPlanSlug('corporate-standard'),
    plan_year: asPlanYear(2026),
    plan_name: { en: 'Corporate Standard' },
    description: null,
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
    created_by: 'actor-uuid',
    updated_by: 'actor-uuid',
  } as unknown as Plan;
}

type DepsOverrides = {
  findOneResult?: Plan | undefined | Error;
  insertResult?: Plan | Error;
  auditFail?: 'persist_failed' | 'invalid_payload';
};

function makeDeps(overrides: DepsOverrides = {}): CreatePlanDeps {
  const planRepo = {
    findOne: vi.fn(async () => {
      const r = overrides.findOneResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    insert: vi.fn(async () => {
      const r = overrides.insertResult ?? makePlan();
      if (r instanceof Error) throw r;
      return r;
    }),
    findByTenantAndYear: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(),
  };

  const audit = {
    record: vi.fn(async () => {
      if (overrides.auditFail === 'persist_failed') {
        return err({ type: 'persist_failed' as const, message: 'write failed' });
      }
      if (overrides.auditFail === 'invalid_payload') {
        return err({ type: 'invalid_payload' as const, issues: ['plan_id too short'] as readonly string[] });
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
  } as unknown as CreatePlanDeps;
}

describe('createPlan use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns invalid_body when input fails shape validation', async () => {
    const deps = makeDeps();
    const result = await createPlan({
      ...baseInput,
      input: { ...validInput, plan_id: '' },
    }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
    expect(deps.planRepo.findOne).not.toHaveBeenCalled();
  });

  it('returns invalid_body for negative annual fee', async () => {
    const deps = makeDeps();
    const result = await createPlan({
      ...baseInput,
      input: { ...validInput, annual_fee_minor_units: -1 },
    }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_body');
  });

  it('returns duplicate_plan when plan already exists', async () => {
    const deps = makeDeps({ findOneResult: makePlan() });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('duplicate_plan');
    expect(deps.planRepo.insert).not.toHaveBeenCalled();
  });

  it('returns server_error when planRepo.findOne throws', async () => {
    const deps = makeDeps({ findOneResult: new Error('DB down') });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') expect(result.error.message).toBe('DB down');
    }
  });

  it('returns server_error when planRepo.insert throws generic error', async () => {
    const deps = makeDeps({
      findOneResult: undefined,
      insertResult: new Error('Insert timeout'),
    });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns duplicate_plan when insert throws unique constraint violation', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    (deps.planRepo.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint'),
    );
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('duplicate_plan');
  });

  it('returns audit_failed when audit returns persist_failed', async () => {
    const deps = makeDeps({
      findOneResult: undefined,
      auditFail: 'persist_failed',
    });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') expect(result.error.message).toBe('write failed');
    }
  });

  it('returns audit_failed with joined issues on invalid_payload', async () => {
    const deps = makeDeps({
      findOneResult: undefined,
      auditFail: 'invalid_payload',
    });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') {
        expect(result.error.message).toBe('plan_id too short');
      }
    }
  });

  it('returns ok with created plan and records plan_created audit', async () => {
    const created = makePlan();
    const deps = makeDeps({
      findOneResult: undefined,
      insertResult: created,
    });
    const result = await createPlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(created);
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.event_type).toBe('plan_created');
    expect(event.payload.plan_id).toBe(asPlanSlug('corporate-standard'));
  });

  it('inserts plan with is_active=false regardless of input', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    await createPlan(baseInput, deps);
    const [, planDraft] = (deps.planRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(planDraft.isActive).toBe(false);
  });
});
