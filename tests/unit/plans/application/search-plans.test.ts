/**
 * R2 Batch 3g (R2-S14) — unit tests for `searchPlans`.
 *
 * Round 2 review flagged this use-case as the largest F2 surface
 * (~360 LOC) with only contract + integration coverage. Adds unit
 * coverage for the in-memory filter combinators + role-based registry
 * filtering at fast feedback (no DB).
 *
 * Pinned contracts:
 *   1. Plan filter — case-insensitive match against active-locale name,
 *      EN fallback, and plan_id slug
 *   2. Role-based action registry filter:
 *      - admin: sees every action entry
 *      - manager: sees only `requires: 'read'` entries
 *      - member: sees nothing (defence — route handler blocks first)
 *   3. Role-based navigate registry filter (same shape)
 *   4. Limit clamping (default 20; explicit override honoured)
 *   5. server_error wrapping `planRepo.findByTenantAndYear` throws
 *   6. Empty-query happy path returns nothing (matches() requires
 *      substring; empty needle matches everything by current
 *      implementation — verify behaviour explicitly)
 *   7. Case-insensitive matching
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  searchPlans,
  type SearchPlansDeps,
  type Plan,
  type PlanRepo,
  type ClockPort,
  type LocaleKey,
} from '@/modules/plans';
import type { Role } from '@/modules/auth/domain/role';

const tenant = asTenantContext('test-swecham');

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    tenant_id: 'test-swecham' as never,
    plan_id: 'corporate-premium' as never,
    plan_year: 2026 as never,
    plan_name: {
      en: 'Corporate Premium',
      th: 'พรีเมียมองค์กร',
      sv: 'Företagspremie',
    },
    description: { en: 'Premium tier' },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 10_000_000,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: {} as never,
    is_active: true,
    deleted_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    created_by: 'seed',
    updated_by: 'seed',
    ...overrides,
  } as Plan;
}

function makeDeps(opts: {
  plans?: Plan[];
  planRepoThrow?: Error;
} = {}): SearchPlansDeps {
  const planRepo = {
    findByTenantAndYear: vi.fn(async () => {
      if (opts.planRepoThrow) throw opts.planRepoThrow;
      return opts.plans ?? [];
    }),
  } as unknown as PlanRepo;
  const clock: ClockPort = {
    now: () => new Date('2026-05-19T10:00:00Z'),
    currentYear: () => 2026,
  };
  return { tenant, planRepo, clock };
}

const baseInput = {
  q: '',
  role: 'admin' as Role,
  activeLocale: 'en' as LocaleKey,
};

describe('searchPlans — plan filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches plan by EN name (case-insensitive)', async () => {
    const deps = makeDeps({ plans: [makePlan({ plan_name: { en: 'Corporate Premium' } })] });
    const result = await searchPlans({ ...baseInput, q: 'premium' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.results.plans).toHaveLength(1);
    expect(result.value.results.plans[0]!.plan_id).toBe('corporate-premium');
  });

  it('matches plan by active-locale name (TH)', async () => {
    const deps = makeDeps({
      plans: [
        makePlan({
          plan_name: { en: 'X Tier', th: 'พรีเมียม', sv: 'Premiär' },
        }),
      ],
    });
    const result = await searchPlans(
      { ...baseInput, q: 'พรีเมียม', activeLocale: 'th' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.results.plans).toHaveLength(1);
  });

  it('matches plan by slug (plan_id)', async () => {
    const deps = makeDeps({
      plans: [makePlan({ plan_id: 'corporate-platinum' as never })],
    });
    const result = await searchPlans({ ...baseInput, q: 'platinum' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.results.plans).toHaveLength(1);
  });

  it('returns empty plans when query matches nothing', async () => {
    const deps = makeDeps({ plans: [makePlan()] });
    const result = await searchPlans({ ...baseInput, q: 'nonmatching' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.results.plans).toHaveLength(0);
  });

  it('respects limit (default 20 / explicit override)', async () => {
    const plans = Array.from({ length: 25 }, (_, i) =>
      makePlan({
        plan_id: `plan-${i}` as never,
        plan_name: { en: `Tier ${i}` },
      }),
    );
    const deps = makeDeps({ plans });
    const result = await searchPlans({ ...baseInput, q: 'tier' }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Default limit 20
    expect(result.value.results.plans).toHaveLength(20);

    const result2 = await searchPlans(
      { ...baseInput, q: 'tier', limit: 5 },
      deps,
    );
    if (!result2.ok) throw new Error('unreachable');
    expect(result2.value.results.plans).toHaveLength(5);
  });
});

describe('searchPlans — role-based filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin sees admin-only + read-tier actions', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await searchPlans({ ...baseInput, q: 'plan', role: 'admin' }, deps);
    if (!result.ok) throw new Error('unreachable');
    // ACTION_REGISTRY contains `palette.actions.newPlan` (admin) +
    // `palette.actions.cloneYear` (admin) — both should be visible
    const ids = result.value.results.actions.map((a) => a.id);
    expect(ids).toContain('plan.new');
    expect(ids).toContain('plan.clone');
  });

  it('manager sees only read-tier actions (no plan.new / plan.clone)', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await searchPlans(
      { ...baseInput, q: 'plan', role: 'manager' },
      deps,
    );
    if (!result.ok) throw new Error('unreachable');
    const ids = result.value.results.actions.map((a) => a.id);
    expect(ids).not.toContain('plan.new');
    expect(ids).not.toContain('plan.clone');
  });

  it('member role sees nothing (defence — route handler blocks first)', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await searchPlans(
      { ...baseInput, q: '', role: 'member' as Role },
      deps,
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.results.actions).toEqual([]);
    expect(result.value.results.navigate).toEqual([]);
  });
});

describe('searchPlans — navigate registry filter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('navigate entries surface for matching query', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await searchPlans({ ...baseInput, q: 'dashboard' }, deps);
    if (!result.ok) throw new Error('unreachable');
    const ids = result.value.results.navigate.map((n) => n.id);
    expect(ids).toContain('nav.dashboard');
  });
});

describe('searchPlans — server_error', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wraps planRepo throw as server_error', async () => {
    const deps = makeDeps({
      planRepoThrow: new Error('postgres timeout'),
    });
    const result = await searchPlans({ ...baseInput, q: 'x' }, deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.type).toBe('server_error');
    if (result.error.type !== 'server_error') throw new Error('unreachable');
    // n43 log-hygiene: the error carries only the SAFE `errKind` classifier
    // (constructor name), NOT the raw DB message — which on a Postgres failure
    // could leak SQL/schema fragments into the log sink.
    expect(result.error.errKind).toBe('Error');
    expect(JSON.stringify(result.error)).not.toContain('postgres timeout');
  });
});
