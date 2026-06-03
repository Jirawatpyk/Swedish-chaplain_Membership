/**
 * Unit tests for `softDeletePlan` use case (T129, US4 FR-010).
 *
 * W0-02 update: the former two-step pattern (separate `members.countActivePlanMembers`
 * + `planRepo.softDelete`) has been replaced by a single atomic
 * `planRepo.softDeleteGuarded` call that acquires the advisory lock, counts,
 * and deletes in one tx. These unit tests mock `softDeleteGuarded` returning
 * the discriminated union `{kind:'deleted'|'has_active_members'|'not_found'}`.
 *
 * The `members` dep and `MemberAttachmentChecker` port are no longer called
 * by this use case — `SoftDeletePlanDeps` no longer carries `members`.
 *
 * Covers all error paths + the happy path at 100% line/branch/function coverage.
 * Audit port is stubbed directly via `audit.record` mock — the
 * `recordAuditEvent` wrapper calls `audit.record` internally and its own
 * zod validation is exercised implicitly.
 *
 * Live cascade / RLS coverage is handled by
 * `tests/integration/plans/soft-delete-toctou-advisory-lock.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  softDeletePlan,
  type SoftDeletePlanDeps,
  type SoftDeletePlanInput,
} from '@/modules/plans/application/soft-delete-plan';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tenant = asTenantContext('swecham');
const planId = asPlanSlug('corporate-standard');
const year = asPlanYear(2026);
const NOW = new Date('2026-04-17T10:00:00.000Z');

const baseInput: SoftDeletePlanInput = {
  planId,
  year,
  actorUserId: 'actor-user-uuid',
  requestId: 'req-test-001',
  sourceIp: '127.0.0.1',
  idempotencyKey: 'idempotency-key-001',
};

function makePlan(overrides: Partial<{
  deleted_at: Date | null;
}> = {}): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: planId,
    plan_year: year,
    plan_name: { en: 'Corporate Standard', th: 'มาตรฐานองค์กร', sv: 'Företagsstandard' },
    description: { en: 'Standard corporate plan', th: 'แผนองค์กรมาตรฐาน', sv: 'Standard företagsplan' },
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
    deleted_at: overrides.deleted_at ?? null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    created_by: 'seed-user',
    updated_by: 'seed-user',
  } as unknown as Plan;
}

// ---------------------------------------------------------------------------
// Dependency factory
//
// W0-02: `members` dep removed from SoftDeletePlanDeps — the use case
// now calls `planRepo.softDeleteGuarded` which encapsulates both count
// and delete atomically under the advisory lock.
// ---------------------------------------------------------------------------

type GuardedResult =
  | { kind: 'deleted'; plan: Plan }
  | { kind: 'has_active_members'; count: number }
  | { kind: 'not_found' }
  | Error; // throw

type DepsOverrides = {
  findOneResult?: Plan | undefined | Error;
  softDeleteGuardedResult?: GuardedResult;
  auditResult?: 'ok' | 'persist_failed';
};

function makeDeps(overrides: DepsOverrides = {}): SoftDeletePlanDeps {
  const planRepo = {
    findOne: vi.fn(async () => {
      const r = overrides.findOneResult;
      if (r instanceof Error) throw r;
      return r;
    }),
    softDeleteGuarded: vi.fn(async () => {
      const r = overrides.softDeleteGuardedResult;
      if (r instanceof Error) throw r;
      // default: deleted with a plan that has deleted_at = NOW
      return r ?? { kind: 'deleted' as const, plan: makePlan({ deleted_at: NOW }) };
    }),
    // Unused by softDeletePlan but satisfy PlanRepo shape for type safety
    findByTenantAndYear: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(),
  };

  const auditFailure = overrides.auditResult === 'persist_failed';
  const audit = {
    record: vi.fn(async () => {
      if (auditFailure) {
        return err({ type: 'persist_failed' as const, message: 'DB write failed' });
      }
      return ok(undefined as void);
    }),
  };

  const clock = {
    now: vi.fn(() => NOW),
    currentYear: vi.fn(() => 2026),
  };

  return {
    tenant,
    planRepo,
    audit,
    clock,
  } as unknown as SoftDeletePlanDeps;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('softDeletePlan use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Step 1: planRepo.findOne error paths --------------------------------

  it('returns server_error when planRepo.findOne throws an Error', async () => {
    const deps = makeDeps({ findOneResult: new Error('DB connection lost') });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('DB connection lost');
      }
    }
    expect(deps.planRepo.softDeleteGuarded).not.toHaveBeenCalled();
  });

  it('returns server_error with string coercion when planRepo.findOne throws non-Error', async () => {
    const planRepo = {
      findOne: vi.fn(async () => { throw 'string error'; }),
      softDeleteGuarded: vi.fn(),
      findByTenantAndYear: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      undelete: vi.fn(),
      cloneYear: vi.fn(),
    };
    const deps = {
      ...makeDeps(),
      planRepo,
    } as unknown as SoftDeletePlanDeps;

    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('string error');
      }
    }
  });

  it('returns not_found when planRepo.findOne returns undefined', async () => {
    const deps = makeDeps({ findOneResult: undefined });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
    expect(deps.planRepo.softDeleteGuarded).not.toHaveBeenCalled();
  });

  // ---- Step 2: idempotent no-op when already deleted ----------------------

  it('returns ok(existing) without calling softDeleteGuarded when plan is already deleted', async () => {
    const alreadyDeleted = makePlan({ deleted_at: new Date('2026-03-01T00:00:00.000Z') });
    const deps = makeDeps({ findOneResult: alreadyDeleted });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(alreadyDeleted);
      expect(result.value.deleted_at).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    }
    expect(deps.planRepo.softDeleteGuarded).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  // ---- Step 3: softDeleteGuarded discriminated-union outcomes -------------

  it('returns server_error when planRepo.softDeleteGuarded throws', async () => {
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: new Error('Soft-delete constraint violation'),
    });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('Soft-delete constraint violation');
      }
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns server_error with string coercion when softDeleteGuarded throws non-Error', async () => {
    const planRepo = {
      findOne: vi.fn(async () => makePlan()),
      softDeleteGuarded: vi.fn(async () => { throw { code: 'PG_CONSTRAINT' }; }),
      findByTenantAndYear: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      undelete: vi.fn(),
      cloneYear: vi.fn(),
    };
    const deps = { ...makeDeps(), planRepo } as unknown as SoftDeletePlanDeps;
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toBe('[object Object]');
      }
    }
  });

  it('returns has_active_members when softDeleteGuarded returns kind=has_active_members', async () => {
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'has_active_members', count: 7 },
    });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('has_active_members');
      if (result.error.type === 'has_active_members') {
        expect(result.error.count).toBe(7);
      }
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('returns not_found when softDeleteGuarded returns kind=not_found (row vanished)', async () => {
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'not_found' },
    });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_found');
    }
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('calls planRepo.softDeleteGuarded with tenant, planId, year, clock.now(), actorUserId', async () => {
    const updatedPlan = makePlan({ deleted_at: NOW });
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'deleted', plan: updatedPlan },
    });
    await softDeletePlan(baseInput, deps);

    expect(deps.planRepo.softDeleteGuarded).toHaveBeenCalledWith(
      tenant,
      planId,
      year,
      NOW,
      baseInput.actorUserId,
    );
  });

  // ---- Step 4: audit failure ----------------------------------------------

  it('returns audit_failed when audit.record returns persist_failed', async () => {
    const updatedPlan = makePlan({ deleted_at: NOW });
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'deleted', plan: updatedPlan },
      auditResult: 'persist_failed',
    });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') {
        expect(result.error.message).toBe('DB write failed');
      }
    }
  });

  it('returns audit_failed with joined issues when audit.record returns invalid_payload', async () => {
    const updatedPlan = makePlan({ deleted_at: NOW });
    // Stub audit.record to return invalid_payload directly (bypasses recordAuditEvent's own zod)
    const audit = {
      record: vi.fn(async () =>
        err({
          type: 'invalid_payload' as const,
          issues: ['plan_id: too short', 'plan_year: out of range'] as readonly string[],
        }),
      ),
    };
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'deleted', plan: updatedPlan },
    });
    // Override the audit port with the invalid_payload one
    const depsWithBadAudit = { ...deps, audit } as unknown as SoftDeletePlanDeps;

    const result = await softDeletePlan(baseInput, depsWithBadAudit);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('audit_failed');
      if (result.error.type === 'audit_failed') {
        expect(result.error.message).toBe('plan_id: too short; plan_year: out of range');
      }
    }
  });

  // ---- Step 5: happy path -------------------------------------------------

  it('returns ok(updatedPlan) and records plan_soft_deleted audit on success', async () => {
    const updatedPlan = makePlan({ deleted_at: NOW });
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'deleted', plan: updatedPlan },
    });
    const result = await softDeletePlan(baseInput, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(updatedPlan);
      expect(result.value.deleted_at).toEqual(NOW);
    }

    // Verify audit was called with the correct event shape
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
    const [auditCtx, auditEvent] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditCtx).toEqual({
      tenant,
      actorUserId: baseInput.actorUserId,
      requestId: baseInput.requestId,
      sourceIp: baseInput.sourceIp,
    });
    expect(auditEvent.event_type).toBe('plan_soft_deleted');
    expect(auditEvent.payload.plan_id).toBe(planId);
    expect(auditEvent.payload.plan_year).toBe(year);
    expect(auditEvent.payload.diff.deleted_at.before).toBeNull();
    expect(auditEvent.payload.diff.deleted_at.after).toBe(NOW.toISOString());
  });

  it('records audit with null sourceIp when sourceIp is null', async () => {
    const updatedPlan = makePlan({ deleted_at: NOW });
    const deps = makeDeps({
      findOneResult: makePlan(),
      softDeleteGuardedResult: { kind: 'deleted', plan: updatedPlan },
    });
    const inputNullIp: SoftDeletePlanInput = { ...baseInput, sourceIp: null };
    const result = await softDeletePlan(inputNullIp, deps);

    expect(result.ok).toBe(true);
    const [auditCtx] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(auditCtx.sourceIp).toBeNull();
  });
});
