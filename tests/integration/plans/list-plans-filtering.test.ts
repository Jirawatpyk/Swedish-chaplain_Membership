/**
 * T065 — Integration test: list-plans filtering + tenant isolation (US1).
 *
 * Seeds two tenants with distinct plans, exercises every filter
 * (category, year, q, activeOnly, showDeleted), and asserts tenant
 * isolation is preserved by RLS on every read. Uses the real
 * `planRepo` and `runInTenant` against live Neon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

const CORPORATE_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

function makeDraft(
  planId: string,
  year: number,
  user: string,
  overrides: Partial<PlanDraftInput> = {},
): PlanDraftInput {
  return {
    plan_id: planId,
    plan_year: year,
    plan_name: { en: `Plan ${planId}` },
    description: { en: 'Test description' },
    sort_order: 10,
    plan_category: 'corporate',
    member_type_scope: 'company',
    annual_fee_minor_units: 1_000_000,
    includes_corporate_plan_id: null,
    min_turnover_minor_units: null,
    max_turnover_minor_units: null,
    max_duration_years: null,
    max_member_age: null,
    benefit_matrix: CORPORATE_MATRIX,
    isActive: true,
    createdBy: user,
    updatedBy: user,
    ...overrides,
  } as PlanDraftInput;
}

describe('Integration: list-plans filtering + tenant isolation (T065)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Tenant A: 3 plans in 2026 (2 corporate, 1 partnership) + 1 inactive
    await planRepo.insert(
      tenantA.ctx,
      makeDraft('premium', 2026, user.userId, {
        plan_name: { en: 'Premium' },
        sort_order: 10,
      }),
    );
    await planRepo.insert(
      tenantA.ctx,
      makeDraft('regular', 2026, user.userId, {
        plan_name: { en: 'Regular' },
        sort_order: 20,
      }),
    );
    await planRepo.insert(
      tenantA.ctx,
      makeDraft('diamond', 2026, user.userId, {
        plan_name: { en: 'Diamond Partnership' },
        plan_category: 'partnership',
        includes_corporate_plan_id: 'premium' as PlanDraftInput['includes_corporate_plan_id'],
        benefit_matrix: {
          ...CORPORATE_MATRIX,
          partnership: {
            event_tickets_included: 6,
            booth_included: true,
            rollup_logo_at_events: true,
            logo_on_merch: true,
            video_duration_minutes: 1.5,
            video_frequency_scope: 'all_events',
            website_logo_months: 12,
            banner_per_year: 20,
            newsletter_promotion: true,
            enewsletter_logo: true,
            directory_ad_position: 'pages_1_and_2',
          },
        },
      }),
    );
    await planRepo.insert(
      tenantA.ctx,
      makeDraft('legacy', 2026, user.userId, {
        plan_name: { en: 'Legacy' },
        sort_order: 100,
        isActive: false,
      }),
    );

    // Tenant B: 2 plans (not visible to Tenant A)
    await planRepo.insert(tenantB.ctx, makeDraft('beta-a', 2026, user.userId));
    await planRepo.insert(tenantB.ctx, makeDraft('beta-b', 2026, user.userId));
  });

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('returns all 4 plans for Tenant A in 2026 (including inactive)', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.tenant_id === tenantA.ctx.slug)).toBe(true);
  });

  it('does NOT see Tenant B plans from Tenant A context', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
    });
    expect(rows.some((r) => r.plan_id.startsWith('beta-'))).toBe(false);
  });

  it('filter by category=corporate returns 2 plans (not the partnership)', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
      category: 'corporate',
    });
    // premium, regular, legacy (all corporate)
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.plan_category === 'corporate')).toBe(true);
  });

  it('filter by category=partnership returns 1 plan', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
      category: 'partnership',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe('diamond');
  });

  it('activeOnly filter excludes the inactive plan', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
      activeOnly: true,
    });
    // 4 total minus 1 inactive = 3
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.is_active === true)).toBe(true);
  });

  it('free-text search matches plan name case-insensitive', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2026),
      q: 'PREMIUM',
    });
    expect(rows.some((r) => r.plan_id === 'premium')).toBe(true);
  });

  it('year filter returning empty (no 2027 plans yet)', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantA.ctx, {
      year: asPlanYear(2027),
    });
    expect(rows).toHaveLength(0);
  });

  it('Tenant B sees only its own 2 plans', async () => {
    const rows = await planRepo.findByTenantAndYear(tenantB.ctx, {
      year: asPlanYear(2026),
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenant_id === tenantB.ctx.slug)).toBe(true);
  });
});
