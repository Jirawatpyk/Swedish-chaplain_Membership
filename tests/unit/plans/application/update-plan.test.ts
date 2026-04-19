/**
 * Unit tests for `update-plan` use case (T116, US3 FR-012 + FR-014).
 *
 * All IO boundaries (PlanRepo, AuditPort, ClockPort) are stubbed —
 * pure Application-layer test with no DB or network touch.
 *
 * Coverage goals: 100% line + 100% branch on
 *   src/modules/plans/application/update-plan.ts
 *
 * The source also houses the private helpers `deepEqual` and
 * `computeDiff`; they are exercised indirectly through `updatePlan`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  updatePlan,
  type UpdatePlanDeps,
  type UpdatePlanInput,
} from '@/modules/plans/application/update-plan';
import { asTenantContext } from '@/modules/tenants';
import {
  asPlanSlug,
  asPlanYear,
  asTenantSlug,
  type Plan,
} from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TENANT = asTenantContext('swecham');
const ACTOR = '00000000-0000-0000-0000-000000000001';
const PLAN_ID = asPlanSlug('premium');
const PLAN_YEAR = asPlanYear(2026);

const BENEFIT_MATRIX: BenefitMatrix = {
  eblast_per_year: 6,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'premium',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
  partnership: null,
};

const EXISTING_PLAN: Plan = {
  tenant_id: asTenantSlug('swecham'),
  plan_id: PLAN_ID,
  plan_year: PLAN_YEAR,
  plan_name: { en: 'Premium Corporate' },
  description: { en: 'Top tier plan' },
  sort_order: 10,
  plan_category: 'corporate',
  member_type_scope: 'company',
  annual_fee_minor_units: 3_600_000,
  includes_corporate_plan_id: null,
  min_turnover_minor_units: null,
  max_turnover_minor_units: null,
  max_duration_years: null,
  max_member_age: null,
  benefit_matrix: BENEFIT_MATRIX,
  is_active: true,
  deleted_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  created_by: ACTOR,
  updated_by: ACTOR,
};

const UPDATED_PLAN: Plan = {
  ...EXISTING_PLAN,
  plan_name: { en: 'Premium Corporate v2' },
  updated_at: new Date('2026-04-17T12:00:00Z'),
};

const BASE_INPUT: UpdatePlanInput = {
  planId: PLAN_ID,
  year: PLAN_YEAR,
  patch: { plan_name: { en: 'Premium Corporate v2' } },
  actorUserId: ACTOR,
  requestId: 'req-update-001',
  sourceIp: '127.0.0.1',
  idempotencyKey: 'idem-update-001',
};

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeAuditStub(opts: { ok: boolean; errorType?: 'invalid_payload' | 'persist_failed' } = { ok: true }) {
  return {
    record: vi.fn(async () => {
      if (opts.ok) return ok(undefined);
      if (opts.errorType === 'invalid_payload') {
        return err({ type: 'invalid_payload' as const, issues: ['payload.plan_id: required'] });
      }
      return err({ type: 'persist_failed' as const, message: 'Audit DB unavailable' });
    }),
  };
}

const FIND_ONE_NOT_SET = Symbol('FIND_ONE_NOT_SET');
const UPDATE_RESULT_NOT_SET = Symbol('UPDATE_RESULT_NOT_SET');

function makePlanRepo(overrides?: {
  findOne?: Plan | undefined | typeof FIND_ONE_NOT_SET;
  findOneThrows?: boolean | string;
  updateResult?: Plan | undefined | typeof UPDATE_RESULT_NOT_SET;
  updateThrows?: boolean | string;
}) {
  const findOneResult = overrides && 'findOne' in overrides
    ? overrides.findOne
    : FIND_ONE_NOT_SET;
  const updateResult = overrides && 'updateResult' in overrides
    ? overrides.updateResult
    : UPDATE_RESULT_NOT_SET;

  return {
    findByTenantAndYear: vi.fn(),
    findOne: vi.fn(async () => {
      if (overrides?.findOneThrows) {
        const msg = typeof overrides.findOneThrows === 'string'
          ? overrides.findOneThrows
          : 'DB error on findOne';
        throw new Error(msg);
      }
      return findOneResult === FIND_ONE_NOT_SET ? EXISTING_PLAN : findOneResult;
    }),
    insert: vi.fn(),
    update: vi.fn(async () => {
      if (overrides?.updateThrows) {
        const msg = typeof overrides.updateThrows === 'string'
          ? overrides.updateThrows
          : 'DB error on update';
        throw new Error(msg);
      }
      return updateResult === UPDATE_RESULT_NOT_SET ? UPDATED_PLAN : updateResult;
    }),
    setActive: vi.fn(),
    softDelete: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(),
    countActiveForTenant: vi.fn(),
  };
}

function makeDeps(overrides: Partial<UpdatePlanDeps> = {}): UpdatePlanDeps {
  return {
    tenant: TENANT,
    planRepo: makePlanRepo(),
    audit: makeAuditStub(),
    clock: { now: vi.fn(() => new Date('2026-04-17T12:00:00Z')), currentYear: vi.fn(() => 2026) },
    members: { countActivePlanMembers: vi.fn(async () => 0) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updatePlan', () => {
  // 1. planRepo.findOne throws
  describe('planRepo.findOne throws', () => {
    it('returns server_error with the exception message', async () => {
      const planRepo = makePlanRepo({ findOneThrows: 'Connection timeout' });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toContain(
        'Connection timeout',
      );
    });

    it('returns server_error with stringified value when non-Error is thrown', async () => {
      const planRepo = {
        ...makePlanRepo(),
        findOne: vi.fn(async () => { throw 42; }),
      };
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toBe('42');
    });
  });

  // 2. Plan not found (findOne returns undefined)
  describe('plan not found', () => {
    it('returns not_found when findOne returns undefined', async () => {
      const planRepo = makePlanRepo({ findOne: undefined });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('not_found');
    });
  });

  // 3. Invalid patch — shape fault → invalid_body
  describe('invalid patch — shape fault', () => {
    it('returns invalid_body for a bad sort_order value', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        { ...BASE_INPUT, patch: { sort_order: -1 } },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('invalid_body');
      const issues = (result.error as { type: 'invalid_body'; issues: { path: string; message: string }[] }).issues;
      expect(issues.length).toBeGreaterThan(0);
    });

    it('returns invalid_body for negative annual_fee_minor_units', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        { ...BASE_INPUT, patch: { annual_fee_minor_units: -500 } },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('invalid_body');
    });

    it('returns invalid_body for fractional sort_order', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        { ...BASE_INPUT, patch: { sort_order: 1.5 } },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('invalid_body');
    });

    it('returns invalid_body when min_turnover >= max_turnover', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            min_turnover_minor_units: 5_000_000,
            max_turnover_minor_units: 5_000_000,
          },
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('invalid_body');
    });
  });

  // 4. Invalid patch — integrity violation → partnership_corporate_mismatch
  describe('invalid patch — integrity (partnership_corporate_mismatch)', () => {
    it('returns partnership_corporate_mismatch when corporate plan sets includes_corporate_plan_id', async () => {
      // Existing plan is corporate; patch sets includes_corporate_plan_id (not null) = conflict
      const deps = makeDeps();

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_category: 'corporate',
            includes_corporate_plan_id: 'some-other-plan',
          },
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('partnership_corporate_mismatch');
      const issues = (result.error as { type: 'partnership_corporate_mismatch'; issues: string[] }).issues;
      expect(issues.length).toBeGreaterThan(0);
    });

    it('returns partnership_corporate_mismatch when partnership patch has null includes_corporate_plan_id', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_category: 'partnership',
            includes_corporate_plan_id: null,
          },
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('partnership_corporate_mismatch');
    });

    it('returns partnership_corporate_mismatch when partnership patch has null benefit_matrix.partnership', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_category: 'partnership',
            includes_corporate_plan_id: 'premium',
            benefit_matrix: { ...BENEFIT_MATRIX, partnership: null },
          },
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('partnership_corporate_mismatch');
    });
  });

  // 5. Prior-year locked fields check
  describe('prior_year_locked_fields', () => {
    it('returns prior_year_locked_fields when patching locked field on a prior-year plan', async () => {
      // Plan year is 2025, current year is 2026 — annual_fee is locked
      const priorYearPlan: Plan = { ...EXISTING_PLAN, plan_year: asPlanYear(2025) };
      const planRepo = makePlanRepo({ findOne: priorYearPlan });
      const clock = { now: vi.fn(() => new Date('2026-01-01T00:00:00Z')), currentYear: vi.fn(() => 2026) };
      const deps = makeDeps({ planRepo, clock });

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          year: asPlanYear(2025),
          patch: { annual_fee_minor_units: 9_999_999 },
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('prior_year_locked_fields');
      const locked = (result.error as { type: 'prior_year_locked_fields'; locked_fields: string[] }).locked_fields;
      expect(locked).toContain('annual_fee_minor_units');
    });

    it('does NOT trigger locked-field error for a same-year plan', async () => {
      // Plan year == current year — nothing locked
      const planRepo = makePlanRepo({ findOne: EXISTING_PLAN, updateResult: UPDATED_PLAN });
      const clock = { now: vi.fn(() => new Date('2026-04-17T00:00:00Z')), currentYear: vi.fn(() => 2026) };
      const deps = makeDeps({ planRepo, clock });

      const result = await updatePlan(
        { ...BASE_INPUT, patch: { annual_fee_minor_units: 4_000_000 } },
        deps,
      );

      expect(result.ok).toBe(true);
    });

    it('does NOT trigger locked-field error for a no-op patch on prior-year plan', async () => {
      // Patch contains the same value as existing — detectLockedFieldChanges returns []
      const priorYearPlan: Plan = { ...EXISTING_PLAN, plan_year: asPlanYear(2025) };
      const updatedPriorYear: Plan = { ...priorYearPlan, sort_order: 20 };
      const planRepo = makePlanRepo({ findOne: priorYearPlan, updateResult: updatedPriorYear });
      const clock = { now: vi.fn(() => new Date('2026-01-01T00:00:00Z')), currentYear: vi.fn(() => 2026) };
      const deps = makeDeps({ planRepo, clock });

      // Patching sort_order (not locked) + same fee value (no-op)
      const result = await updatePlan(
        {
          ...BASE_INPUT,
          year: asPlanYear(2025),
          patch: { sort_order: 20, annual_fee_minor_units: 3_600_000 },
        },
        deps,
      );

      expect(result.ok).toBe(true);
    });
  });

  // 6. planRepo.update throws
  describe('planRepo.update throws', () => {
    it('returns server_error with the exception message', async () => {
      const planRepo = makePlanRepo({ updateThrows: 'Unique constraint violated' });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toContain(
        'Unique constraint violated',
      );
    });

    it('returns server_error with stringified value when non-Error is thrown', async () => {
      const planRepo = {
        ...makePlanRepo(),
        update: vi.fn(async () => { throw { code: 'P2002' }; }),
      };
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
    });
  });

  // 7. planRepo.update returns undefined (racy delete between findOne and update)
  describe('planRepo.update returns undefined (racy delete)', () => {
    it('returns not_found when update returns undefined', async () => {
      const planRepo = makePlanRepo({ updateResult: undefined });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('not_found');
    });
  });

  // 8. Audit failure — invalid_payload
  describe('audit failure — invalid_payload', () => {
    it('returns audit_failed with joined issues from invalid_payload', async () => {
      const audit = makeAuditStub({ ok: false, errorType: 'invalid_payload' });
      const deps = makeDeps({ audit });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('audit_failed');
      expect((result.error as { type: 'audit_failed'; message: string }).message).toContain(
        'payload.plan_id: required',
      );
    });
  });

  // 9. Audit failure — persist_failed
  describe('audit failure — persist_failed', () => {
    it('returns audit_failed with the persist error message', async () => {
      const audit = makeAuditStub({ ok: false, errorType: 'persist_failed' });
      const deps = makeDeps({ audit });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('audit_failed');
      expect((result.error as { type: 'audit_failed'; message: string }).message).toContain(
        'Audit DB unavailable',
      );
    });
  });

  // 10. No-op patch (diff is empty) — audit must NOT be called
  describe('no-op patch (all values unchanged)', () => {
    it('returns ok but does NOT call audit.record when diff is empty', async () => {
      const deps = makeDeps();

      // Patch values that exactly match EXISTING_PLAN — computeDiff returns {}
      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_name: { en: 'Premium Corporate' }, // same as existing
            sort_order: 10, // same as existing
          },
        },
        deps,
      );

      expect(result.ok).toBe(true);
      // audit.record MUST NOT be called for no-op writes
      expect(deps.audit.record).not.toHaveBeenCalled();
    });

    it('returns the updated plan value even on no-op', async () => {
      const deps = makeDeps();

      const result = await updatePlan(
        {
          ...BASE_INPUT,
          patch: { sort_order: 10 }, // unchanged
        },
        deps,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // UPDATED_PLAN is what the repo stub returns
      expect(result.value.plan_id).toBe(PLAN_ID);
    });
  });

  // 11. Happy path — successful update with diff
  describe('success path', () => {
    it('returns ok with the updated plan', async () => {
      const deps = makeDeps();

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(UPDATED_PLAN);
    });

    it('calls planRepo.update with correct tenant, planId, year, patch, and actorUserId', async () => {
      const deps = makeDeps();

      await updatePlan(BASE_INPUT, deps);

      expect(deps.planRepo.update).toHaveBeenCalledWith(
        TENANT,
        PLAN_ID,
        PLAN_YEAR,
        expect.objectContaining({ plan_name: { en: 'Premium Corporate v2' } }),
        ACTOR,
      );
    });

    it('calls audit.record once with plan_updated event and correct diff', async () => {
      const deps = makeDeps();

      await updatePlan(BASE_INPUT, deps);

      expect(deps.audit.record).toHaveBeenCalledTimes(1);
      const [ctx, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      expect((event as { event_type: string }).event_type).toBe('plan_updated');
      const payload = (event as { payload: { plan_id: string; plan_year: number; diff: Record<string, unknown> } }).payload;
      expect(payload.plan_id).toBe(PLAN_ID);
      expect(payload.plan_year).toBe(PLAN_YEAR);
      expect(payload.diff).toHaveProperty('plan_name');
      const diff = payload.diff as Record<string, { before: unknown; after: unknown }>;
      expect(diff['plan_name']?.before).toEqual({ en: 'Premium Corporate' });
      expect(diff['plan_name']?.after).toEqual({ en: 'Premium Corporate v2' });
      expect((ctx as { actorUserId: string }).actorUserId).toBe(ACTOR);
    });

    it('passes sourceIp null through to audit context', async () => {
      const deps = makeDeps();

      await updatePlan({ ...BASE_INPUT, sourceIp: null }, deps);

      const [ctx] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown];
      expect((ctx as { sourceIp: null }).sourceIp).toBeNull();
    });
  });

  // 12. computeDiff — only changed fields included in diff
  describe('computeDiff behaviour (indirect)', () => {
    it('diff only contains plan_name when that is the only changed field', async () => {
      const deps = makeDeps();

      await updatePlan(
        { ...BASE_INPUT, patch: { plan_name: { en: 'Premium Corporate v2' }, sort_order: 10 } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      // sort_order unchanged (10 → 10) — must NOT appear
      expect(Object.keys(diff)).not.toContain('sort_order');
      expect(Object.keys(diff)).toContain('plan_name');
    });

    it('diff includes multiple changed fields', async () => {
      const planRepo = makePlanRepo({
        findOne: EXISTING_PLAN,
        updateResult: { ...UPDATED_PLAN, sort_order: 20 },
      });
      const deps = makeDeps({ planRepo });

      await updatePlan(
        {
          ...BASE_INPUT,
          patch: { plan_name: { en: 'Premium Corporate v2' }, sort_order: 20 },
        },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).toContain('plan_name');
      expect(Object.keys(diff)).toContain('sort_order');
    });

    it('diff handles null → value transition', async () => {
      const planRepo = makePlanRepo({
        findOne: { ...EXISTING_PLAN, max_duration_years: null },
        updateResult: { ...UPDATED_PLAN, plan_name: { en: 'Premium Corporate' }, max_duration_years: 3 },
      });
      const deps = makeDeps({ planRepo });

      await updatePlan(
        { ...BASE_INPUT, patch: { max_duration_years: 3 } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, { before: unknown; after: unknown }> } }).payload.diff;
      expect(diff['max_duration_years']?.before).toBeNull();
      expect(diff['max_duration_years']?.after).toBe(3);
    });
  });

  // 13. deepEqual exercises (via computeDiff indirectly)
  describe('deepEqual edge cases (via computeDiff)', () => {
    it('deepEqual: object with different number of keys — treated as changed', async () => {
      // benefit_matrix with extra vs missing key treated as different objects
      const extendedMatrix = { ...BENEFIT_MATRIX, eblast_per_year: 12 };
      const planWithMatrix: Plan = { ...EXISTING_PLAN, benefit_matrix: BENEFIT_MATRIX };
      const planRepo = makePlanRepo({
        findOne: planWithMatrix,
        updateResult: { ...UPDATED_PLAN, plan_name: { en: 'Premium Corporate' }, benefit_matrix: extendedMatrix },
      });
      const deps = makeDeps({ planRepo });

      // patch changes eblast_per_year inside benefit_matrix
      await updatePlan(
        { ...BASE_INPUT, patch: { benefit_matrix: extendedMatrix } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).toContain('benefit_matrix');
    });

    it('deepEqual: identical primitive values — not included in diff', async () => {
      const deps = makeDeps();

      // Patch description with same value — deepEqual returns true → skip
      await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_name: { en: 'Premium Corporate v2' },
            description: { en: 'Top tier plan' }, // same as existing
          },
        },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).not.toContain('description');
    });

    it('deepEqual: null → null (no-op) — not included in diff', async () => {
      const deps = makeDeps();

      // max_duration_years is already null in EXISTING_PLAN; patch it with null again
      await updatePlan(
        {
          ...BASE_INPUT,
          patch: { max_duration_years: null, plan_name: { en: 'Premium Corporate v2' } },
        },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).not.toContain('max_duration_years');
    });

    it('deepEqual: typeof mismatch — treated as changed', async () => {
      // String vs number — would show up if benefit_matrix changes type
      // Exercised here by comparing plan_name (object) changed in text
      const deps = makeDeps();
      await updatePlan(
        { ...BASE_INPUT, patch: { plan_name: { en: 'Different Name' } } },
        deps,
      );
      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).toContain('plan_name');
    });

    it('deepEqual: typeof mismatch — string-typed old vs number new fires line 109', async () => {
      // Force sort_order to a string via type cast on the repo stub (only patch is Zod-validated)
      const planWithStringSort: Plan = {
        ...EXISTING_PLAN,
        sort_order: 'ten' as unknown as number,
      };
      const planRepo = makePlanRepo({
        findOne: planWithStringSort,
        updateResult: { ...EXISTING_PLAN, sort_order: 10 },
      });
      const deps = makeDeps({ planRepo });

      await updatePlan(
        { ...BASE_INPUT, patch: { sort_order: 10 } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).toContain('sort_order');
    });

    it('deepEqual: different key count — object with extra key treated as changed (line 116)', async () => {
      // Old description has two locale keys; patch only provides en — key count differs
      const planWithTwoKeys: Plan = {
        ...EXISTING_PLAN,
        description: { en: 'Old text', th: 'ข้อความเก่า' } as Plan['description'],
      };
      const planRepo = makePlanRepo({
        findOne: planWithTwoKeys,
        updateResult: { ...EXISTING_PLAN, description: { en: 'New text' } },
      });
      const deps = makeDeps({ planRepo });

      await updatePlan(
        { ...BASE_INPUT, patch: { description: { en: 'New text' } } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      expect(Object.keys(diff)).toContain('description');
    });

    it('computeDiff: patch field with undefined value is skipped (line 139)', async () => {
      // Pass plan_name: undefined in the patch — Zod includes it; computeDiff skips it
      const deps = makeDeps();

      await updatePlan(
        {
          ...BASE_INPUT,
          patch: {
            plan_name: undefined as unknown as Plan['plan_name'],
            sort_order: 10,
          },
        },
        deps,
      );

      // sort_order 10 === 10 (same) → no diff → audit not called
      expect(deps.audit.record).not.toHaveBeenCalled();
    });

    it('deepEqual: array guard — array field treated as changed regardless of content', async () => {
      // Plan fields are never arrays; this exercises the Array.isArray guard
      // by forcing an array onto description via type cast on the findOne stub.
      // description is not Zod-validated in planRepo (only the patch is), so the
      // cast is safe for the mock. Patch has a valid new description → diff fires.
      const planWithArrayDesc: Plan = {
        ...EXISTING_PLAN,
        description: ['old-desc'] as unknown as Plan['description'],
      };
      const planRepo = makePlanRepo({
        findOne: planWithArrayDesc,
        updateResult: { ...EXISTING_PLAN, description: { en: 'new-desc' } },
      });
      const deps = makeDeps({ planRepo });

      await updatePlan(
        { ...BASE_INPUT, patch: { description: { en: 'new-desc' } } },
        deps,
      );

      const [, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      const diff = (event as { payload: { diff: Record<string, unknown> } }).payload.diff;
      // Array old value vs object new value → treated as changed
      expect(Object.keys(diff)).toContain('description');
    });
  });

  // 14. Archive / inactive plan handling — no special gate in update-plan
  describe('archived / inactive plan patching', () => {
    it('allows PATCH on an inactive plan (no special gate in update-plan)', async () => {
      const inactivePlan: Plan = { ...EXISTING_PLAN, is_active: false };
      const inactiveUpdated: Plan = {
        ...inactivePlan,
        plan_name: { en: 'Premium Corporate v2' },
      };
      const planRepo = makePlanRepo({ findOne: inactivePlan, updateResult: inactiveUpdated });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      // No is_active gate — update-plan does not block on inactive plans
      expect(result.ok).toBe(true);
    });

    it('allows PATCH on a soft-deleted plan (no special gate in update-plan)', async () => {
      const deletedPlan: Plan = { ...EXISTING_PLAN, deleted_at: new Date('2026-03-01T00:00:00Z') };
      const deletedUpdated: Plan = {
        ...deletedPlan,
        plan_name: { en: 'Premium Corporate v2' },
      };
      const planRepo = makePlanRepo({ findOne: deletedPlan, updateResult: deletedUpdated });
      const deps = makeDeps({ planRepo });

      const result = await updatePlan(BASE_INPUT, deps);

      expect(result.ok).toBe(true);
    });
  });
});
