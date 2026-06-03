import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  undeletePlan,
  type UndeletePlanInput,
  type UndeletePlanDeps,
} from '@/modules/plans/application/undelete-plan';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';

const tenant = asTenantContext('swecham');
const planId = asPlanSlug('corporate-standard');
const year = asPlanYear(2026);
const NOW = new Date('2026-04-17T10:00:00.000Z');
const DELETED_AT = new Date('2026-03-01T00:00:00.000Z');

const baseInput: UndeletePlanInput = {
  planId,
  year,
  actorUserId: 'actor-uuid',
  requestId: 'req-001',
  sourceIp: '10.0.0.1',
  idempotencyKey: 'idem-001',
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
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
  undeleteResult?: Plan | undefined | Error;
  auditFail?: 'persist_failed' | 'invalid_payload';
};

function makeDeps(overrides: DepsOverrides = {}): UndeletePlanDeps {
  const planRepo = {
    findOne: vi.fn(async () => {
      const r = overrides.findOneResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    undelete: vi.fn(async () => {
      const r = overrides.undeleteResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    findByTenantAndYear: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    cloneYear: vi.fn(),
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
  } as unknown as UndeletePlanDeps;
}

describe('undeletePlan use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when planRepo.findOne throws', async () => {
    const deps = makeDeps({ findOneResult: new Error('DB down') });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') expect(result.error.message).toBe('DB down');
    }
  });

  it('returns not_found when plan missing', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    expect(deps.planRepo.undelete).not.toHaveBeenCalled();
  });

  it('returns ok idempotently when plan is not deleted (deleted_at=null)', async () => {
    const notDeleted = makePlan({ deleted_at: null });
    const deps = makeDeps({ findOneResult: notDeleted });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(notDeleted);
    expect(deps.planRepo.undelete).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns server_error when planRepo.undelete throws', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT }),
      undeleteResult: new Error('Undelete constraint'),
    });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns not_found when planRepo.undelete returns undefined', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT }),
      undeleteResult: undefined,
    });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_found');
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns audit_failed on persist_failed', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT }),
      undeleteResult: makePlan({ deleted_at: null }),
      auditFail: 'persist_failed',
    });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') expect(result.error.message).toBe('write error');
    }
  });

  it('returns audit_failed with joined issues on invalid_payload', async () => {
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT }),
      undeleteResult: makePlan({ deleted_at: null }),
      auditFail: 'invalid_payload',
    });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') expect(result.error.message).toBe('bad field');
    }
  });

  it('returns ok and records plan_undeleted audit with diff on success', async () => {
    const updated = makePlan({ deleted_at: null, is_active: false });
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT, is_active: false }),
      undeleteResult: updated,
    });
    const result = await undeletePlan(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(updated);
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.event_type).toBe('plan_undeleted');
    expect(event.payload.diff.deleted_at.before).toBe(DELETED_AT.toISOString());
    expect(event.payload.diff.deleted_at.after).toBeNull();
  });

  it('includes is_active diff when plan was active at delete time', async () => {
    const updated = makePlan({ deleted_at: null, is_active: false });
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT, is_active: true }),
      undeleteResult: updated,
    });
    await undeletePlan(baseInput, deps);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.payload.diff.is_active).toEqual({ before: true, after: false });
  });

  it('omits is_active from diff when plan was already inactive at delete time', async () => {
    const updated = makePlan({ deleted_at: null, is_active: false });
    const deps = makeDeps({
      findOneResult: makePlan({ deleted_at: DELETED_AT, is_active: false }),
      undeleteResult: updated,
    });
    await undeletePlan(baseInput, deps);
    const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event.payload.diff.is_active).toBeUndefined();
  });
});
