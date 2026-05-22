/**
 * R2 Batch 3b (R2-I7) — unit tests for `getPlanForMember`.
 *
 * F7 EBlast bridge depends on this for FR-002 precondition `a` + FR-009
 * quota cap derivation. F7 shipped to prod (PR #23, 2026-05-03) without
 * unit coverage for the bridge — Round 2 review flagged the gap. Pins:
 *   1. member_not_found (F3 lookup returns not_found)
 *   2. plan_not_found (F2 lookup returns undefined)
 *   3. member_no_eblast_quota (matrix.eblast_per_year === 0)
 *   4. server_error × 3 (F3 lookup throws, F3 lookup returns server_error,
 *      F2 lookup throws)
 *   5. happy path — extracts eblast_per_year + planCode from matrix
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  getPlanForMember,
  type GetPlanForMemberDeps,
  type MemberPlanIdentityLookup,
  type Plan,
  type PlanRepo,
  type BenefitMatrix,
} from '@/modules/plans';

const tenant = asTenantContext('swecham');
const MEMBER_ID = 'mem-uuid-001';
const PLAN_ID = 'corporate-premium';

const CORPORATE_MATRIX_WITH_EBLAST: BenefitMatrix = {
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

const FREE_TIER_MATRIX: BenefitMatrix = {
  ...CORPORATE_MATRIX_WITH_EBLAST,
  eblast_per_year: 0,
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: PLAN_ID as never,
    plan_year: 2026 as never,
    plan_name: { en: 'Premium' },
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
    benefit_matrix: CORPORATE_MATRIX_WITH_EBLAST,
    is_active: true,
    deleted_at: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    created_by: 'seed',
    updated_by: 'seed',
    ...overrides,
  } as unknown as Plan;
}

function makeDeps(overrides: {
  memberLookupResult?:
    | { ok: true; value: { planId: string; planYear: number } }
    | { ok: false; code: 'not_found' | 'server_error' }
    | Error;
  planRepoResult?: Plan | undefined | Error;
}): GetPlanForMemberDeps {
  const memberLookup: MemberPlanIdentityLookup = {
    findPlanIdentityByMemberId: vi.fn(async () => {
      const r = overrides.memberLookupResult;
      if (r instanceof Error) throw r;
      return (
        r ??
        ({ ok: true, value: { planId: PLAN_ID, planYear: 2026 } } as const)
      );
    }),
  };

  const planRepo = {
    findOne: vi.fn(async () => {
      const r = overrides.planRepoResult;
      if (r instanceof Error) throw r;
      return r === undefined ? undefined : (r ?? makePlan());
    }),
  } as unknown as PlanRepo;

  return { tenant, planRepo, memberLookup };
}

describe('getPlanForMember — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns plan summary with eblastPerYear + planCode for active member with quota', async () => {
    const deps = makeDeps({ planRepoResult: makePlan() });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({
      planId: PLAN_ID,
      planCode: 'corporate',
      eblastPerYear: 6,
    });
    expect(deps.memberLookup.findPlanIdentityByMemberId).toHaveBeenCalledWith(
      tenant,
      MEMBER_ID,
    );
  });
});

describe('getPlanForMember — error branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns member_not_found when F3 lookup returns not_found', async () => {
    const deps = makeDeps({
      memberLookupResult: { ok: false, code: 'not_found' },
    });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.member_not_found');
  });

  it('returns server_error when F3 lookup returns server_error', async () => {
    const deps = makeDeps({
      memberLookupResult: { ok: false, code: 'server_error' },
    });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.server_error');
  });

  it('returns server_error when F3 lookup throws', async () => {
    const deps = makeDeps({
      memberLookupResult: new Error('F3 client connection refused'),
    });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.server_error');
    if (result.error.code !== 'plan_lookup.server_error')
      throw new Error('unreachable');
    expect(result.error.message).toContain('connection refused');
  });

  it('returns plan_not_found when F2 planRepo.findOne returns undefined', async () => {
    const deps = makeDeps({ planRepoResult: undefined });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.plan_not_found');
  });

  it('returns server_error when F2 planRepo.findOne throws', async () => {
    const deps = makeDeps({
      planRepoResult: new Error('postgres timeout'),
    });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.server_error');
  });

  it('returns member_no_eblast_quota when matrix.eblast_per_year === 0 (free-tier rejection)', async () => {
    const deps = makeDeps({
      planRepoResult: makePlan({ benefit_matrix: FREE_TIER_MATRIX }),
    });
    const result = await getPlanForMember(deps, MEMBER_ID);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('plan_lookup.member_no_eblast_quota');
    if (result.error.code !== 'plan_lookup.member_no_eblast_quota')
      throw new Error('unreachable');
    expect(result.error.planId).toBe(PLAN_ID);
  });
});
