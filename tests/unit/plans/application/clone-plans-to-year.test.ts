/**
 * Unit tests for `clone-plans-to-year` use case (T099, US2 FR-009).
 *
 * All IO boundaries (PlanRepo, AuditPort, ClockPort) are stubbed with vi.fn()
 * — this is a pure Application-layer test; no DB or network touch.
 *
 * Coverage goals: 100% line + 100% branch on
 *   src/modules/plans/application/clone-plans-to-year.ts
 */

import { describe, expect, it, vi } from 'vitest';
import {
  clonePlansToYear,
  type ClonePlansToYearDeps,
  type ClonePlansToYearInput,
} from '@/modules/plans/application/clone-plans-to-year';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
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
// Shared test fixtures
// ---------------------------------------------------------------------------

const TENANT = asTenantContext('swecham');
const ACTOR = '00000000-0000-0000-0000-000000000001';
const SOURCE_YEAR = asPlanYear(2025);
const TARGET_YEAR = asPlanYear(2026);

const CLONE_SUMMARY = {
  sourceYear: SOURCE_YEAR,
  targetYear: TARGET_YEAR,
  clonedPlanIds: [asPlanSlug('premium'), asPlanSlug('standard')] as ReadonlyArray<ReturnType<typeof asPlanSlug>>,
  count: 2,
};

const BASE_INPUT: ClonePlansToYearInput = {
  sourceYear: SOURCE_YEAR,
  targetYear: TARGET_YEAR,
  activateCloned: false,
  actorUserId: ACTOR,
  requestId: 'req-clone-001',
  sourceIp: '127.0.0.1',
  idempotencyKey: 'idem-001',
};

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeAuditStub(opts: { ok: boolean; errorType?: 'invalid_payload' | 'persist_failed' } = { ok: true }) {
  return {
    record: vi.fn(async () => {
      if (opts.ok) return ok(undefined);
      if (opts.errorType === 'invalid_payload') {
        return err({ type: 'invalid_payload' as const, issues: ['payload.count: invalid'] });
      }
      return err({ type: 'persist_failed' as const, message: 'DB write failed' });
    }),
  };
}

function makeDeps(overrides: Partial<ClonePlansToYearDeps> = {}): ClonePlansToYearDeps {
  const planRepo = {
    findByTenantAndYear: vi.fn(),
    findOne: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    setActive: vi.fn(),
    softDeleteGuarded: vi.fn(),
    undelete: vi.fn(),
    cloneYear: vi.fn(async () => ok(CLONE_SUMMARY)),
  };

  const audit = makeAuditStub();
  const clock = { now: vi.fn(() => new Date('2026-01-01T00:00:00Z')), currentYear: vi.fn(() => 2026) };
  const members = { countActivePlanMembers: vi.fn(async () => 0) };

  return { tenant: TENANT, planRepo, audit, clock, members, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clonePlansToYear', () => {
  // 1. Guard: source === target
  describe('source_year === target_year guard', () => {
    it('returns invalid_body when sourceYear equals targetYear', async () => {
      const deps = makeDeps();
      const result = await clonePlansToYear(
        { ...BASE_INPUT, sourceYear: asPlanYear(2026), targetYear: asPlanYear(2026) },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('invalid_body');
      expect((result.error as { type: 'invalid_body'; message: string }).message).toMatch(
        /source_year and target_year must differ/i,
      );
      // Repo should never be called
      expect(deps.planRepo.cloneYear).not.toHaveBeenCalled();
    });
  });

  // 2. planRepo.cloneYear throws (unexpected exception → server_error)
  describe('planRepo.cloneYear throws', () => {
    it('returns server_error with the exception message', async () => {
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        cloneYear: vi.fn(async () => { throw new Error('Postgres connection lost'); }),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toContain(
        'Postgres connection lost',
      );
    });

    it('returns server_error with stringified value when non-Error is thrown', async () => {
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        cloneYear: vi.fn(async () => { throw 'raw string error'; }),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toBe('raw string error');
    });
  });

  // 3. planRepo.cloneYear returns err({type: 'target_year_populated'})
  describe('target_year_populated', () => {
    it('propagates existing_count from the repo error', async () => {
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        cloneYear: vi.fn(async () =>
          err({ type: 'target_year_populated' as const, existingCount: 7 }),
        ),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('target_year_populated');
      expect(
        (result.error as { type: 'target_year_populated'; existing_count: number }).existing_count,
      ).toBe(7);
    });
  });

  // 4. planRepo.cloneYear returns err({type: 'source_year_empty'})
  describe('source_year_empty', () => {
    it('returns source_year_empty error', async () => {
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        cloneYear: vi.fn(async () => err({ type: 'source_year_empty' as const })),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('source_year_empty');
    });
  });

  // 5. Unhandled clone error type → server_error fallback
  describe('unhandled clone repo error type', () => {
    it('returns server_error with JSON stringified error details', async () => {
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        // Simulate a future repo error type not handled in the use case
        cloneYear: vi.fn(async () =>
          err({ type: 'unexpected_future_error' as unknown as 'source_year_empty' }),
        ),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('server_error');
      expect((result.error as { type: 'server_error'; message: string }).message).toContain(
        'unhandled clone error',
      );
    });
  });

  // 6. Audit write fails with invalid_payload
  describe('audit failure — invalid_payload', () => {
    it('returns audit_failed with joined issues string', async () => {
      const audit = makeAuditStub({ ok: false, errorType: 'invalid_payload' });
      const deps = makeDeps({ audit });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('audit_failed');
      expect((result.error as { type: 'audit_failed'; message: string }).message).toContain(
        'payload.count: invalid',
      );
    });
  });

  // 7. Audit write fails with persist_failed
  describe('audit failure — persist_failed', () => {
    it('returns audit_failed with the persist error message', async () => {
      const audit = makeAuditStub({ ok: false, errorType: 'persist_failed' });
      const deps = makeDeps({ audit });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.type).toBe('audit_failed');
      expect((result.error as { type: 'audit_failed'; message: string }).message).toContain(
        'DB write failed',
      );
    });
  });

  // 8. Happy path — successful clone
  describe('success path', () => {
    it('returns ok with correct envelope when clone succeeds', async () => {
      const deps = makeDeps();

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({
        source_year: 2025,
        target_year: 2026,
        cloned_count: 2,
        cloned_plan_ids: CLONE_SUMMARY.clonedPlanIds,
      });
    });

    it('calls planRepo.cloneYear with correct arguments', async () => {
      const deps = makeDeps();

      await clonePlansToYear({ ...BASE_INPUT, activateCloned: true }, deps);

      expect(deps.planRepo.cloneYear).toHaveBeenCalledWith(
        TENANT,
        SOURCE_YEAR,
        TARGET_YEAR,
        true,
        ACTOR,
      );
    });

    it('calls audit.record exactly once with plan_cloned event', async () => {
      const deps = makeDeps();

      await clonePlansToYear(BASE_INPUT, deps);

      expect(deps.audit.record).toHaveBeenCalledTimes(1);
      const [ctx, event] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, unknown];
      expect((event as { event_type: string }).event_type).toBe('plan_cloned');
      const payload = (event as { payload: { source_year: number; target_year: number; count: number; plan_ids: string[] } }).payload;
      expect(payload.source_year).toBe(2025);
      expect(payload.target_year).toBe(2026);
      expect(payload.count).toBe(2);
      expect(payload.plan_ids).toEqual(['premium', 'standard']);
      expect((ctx as { actorUserId: string }).actorUserId).toBe(ACTOR);
      expect((ctx as { requestId: string }).requestId).toBe('req-clone-001');
    });

    it('passes sourceIp null through to audit context', async () => {
      const deps = makeDeps();

      await clonePlansToYear({ ...BASE_INPUT, sourceIp: null }, deps);

      const [ctx] = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown];
      expect((ctx as { sourceIp: null }).sourceIp).toBeNull();
    });

    it('envelope cloned_plan_ids matches the order returned by repo', async () => {
      const ordered = [asPlanSlug('gold'), asPlanSlug('silver'), asPlanSlug('bronze')] as ReadonlyArray<ReturnType<typeof asPlanSlug>>;
      const planRepo = {
        findByTenantAndYear: vi.fn(),
        findOne: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        setActive: vi.fn(),
        softDeleteGuarded: vi.fn(),
        undelete: vi.fn(),
        cloneYear: vi.fn(async () =>
          ok({ sourceYear: SOURCE_YEAR, targetYear: TARGET_YEAR, clonedPlanIds: ordered, count: 3 }),
        ),
      };
      const deps = makeDeps({ planRepo });

      const result = await clonePlansToYear(BASE_INPUT, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cloned_plan_ids).toEqual(ordered);
      expect(result.value.cloned_count).toBe(3);
    });
  });

  // 9. activateCloned=false vs true propagated correctly
  describe('activateCloned propagation', () => {
    it('passes activateCloned=false to cloneYear', async () => {
      const deps = makeDeps();
      await clonePlansToYear({ ...BASE_INPUT, activateCloned: false }, deps);
      expect(deps.planRepo.cloneYear).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), false, expect.anything(),
      );
    });

    it('passes activateCloned=true to cloneYear', async () => {
      const deps = makeDeps();
      await clonePlansToYear({ ...BASE_INPUT, activateCloned: true }, deps);
      expect(deps.planRepo.cloneYear).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), true, expect.anything(),
      );
    });
  });
});
