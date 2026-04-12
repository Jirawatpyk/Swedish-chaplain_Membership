/**
 * T150 — Integration test: search-plans filter correctness (US6).
 *
 * Exercises the `searchPlans` use case against live Neon:
 *   - exact match ("Premium")
 *   - prefix match ("prem")
 *   - case-insensitive match ("PREMIUM")
 *   - cross-locale: active locale TH but search term matches EN name
 *   - role filter: manager sees only read-category actions
 *   - role filter: member gets empty action + navigate pools
 *
 * Static action/navigate registries are filtered in-memory so the
 * role-filter assertions do not need a second tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchPlans } from '@/modules/plans/application/search-plans';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput, ClockPort } from '@/modules/plans/application/ports';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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
  user: string,
  overrides: Partial<PlanDraftInput> = {},
): PlanDraftInput {
  return {
    plan_id: planId,
    plan_year: 2026,
    plan_name: { en: `Plan ${planId}` },
    description: { en: '' },
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

const fixedClock: ClockPort = {
  now: () => new Date('2026-06-15T00:00:00Z'),
  currentYear: () => 2026,
};

describe('Integration: search-plans filter correctness (T150, US6)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed 3 plans: premium, diamond partnership (with TH name), gold
    await planRepo.insert(
      tenant.ctx,
      makeDraft('premium', user.userId, {
        plan_name: { en: 'Premium', th: 'พรีเมียม', sv: 'Premium' },
        sort_order: 10,
      }),
    );
    await planRepo.insert(
      tenant.ctx,
      makeDraft('diamond', user.userId, {
        plan_name: { en: 'Diamond Partnership', th: 'เพชร', sv: 'Diamant' },
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
        sort_order: 20,
      }),
    );
    await planRepo.insert(
      tenant.ctx,
      makeDraft('gold', user.userId, {
        plan_name: { en: 'Gold', th: 'ทอง', sv: 'Guld' },
        sort_order: 30,
      }),
    );
  });

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('exact match returns the matching plan', async () => {
    const result = await searchPlans(
      { q: 'Premium', role: 'admin', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hits = result.value.results.plans;
    expect(hits.some((h) => h.plan_id === 'premium')).toBe(true);
  });

  it('prefix match is case-insensitive and returns the plan', async () => {
    const result = await searchPlans(
      { q: 'prem', role: 'admin', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.plans.some((h) => h.plan_id === 'premium')).toBe(
      true,
    );
  });

  it('fully upper-case search still matches', async () => {
    const result = await searchPlans(
      { q: 'DIAMOND', role: 'admin', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.plans.some((h) => h.plan_id === 'diamond')).toBe(
      true,
    );
  });

  it('cross-locale: TH user searches EN name and still matches', async () => {
    // Active locale is TH but the user typed the English word "gold" —
    // the use case falls back to matching against plan_name.en so the
    // Swedish/English command-palette muscle memory keeps working.
    const result = await searchPlans(
      { q: 'Gold', role: 'admin', activeLocale: 'th' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hits = result.value.results.plans;
    expect(hits.some((h) => h.plan_id === 'gold')).toBe(true);
    // The returned plan_name is localised to the active locale (TH).
    const gold = hits.find((h) => h.plan_id === 'gold');
    expect(gold?.plan_name).toBe('ทอง');
  });

  it('plan_id substring match works', async () => {
    const result = await searchPlans(
      { q: 'diamo', role: 'admin', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.plans.some((h) => h.plan_id === 'diamond')).toBe(
      true,
    );
  });

  it('admin role sees all 4 action registry entries (when q matches all)', async () => {
    const result = await searchPlans(
      { q: 'palette', role: 'admin', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All 4 action ids contain the i18n key prefix "palette.actions.*"
    expect(result.value.results.actions.length).toBeGreaterThanOrEqual(4);
    expect(result.value.results.navigate.length).toBeGreaterThanOrEqual(4);
  });

  it('manager role sees only read-category actions (viewAuditLog) — no create/clone', async () => {
    const result = await searchPlans(
      { q: 'palette', role: 'manager', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actionIds = result.value.results.actions.map((a) => a.id);
    // Only `audit.view` requires `read` in the static registry
    expect(actionIds).toContain('audit.view');
    expect(actionIds).not.toContain('plan.new');
    expect(actionIds).not.toContain('plan.clone');
    expect(actionIds).not.toContain('fee.edit');
  });

  it('member role returns empty action + navigate pools', async () => {
    const result = await searchPlans(
      { q: 'palette', role: 'member', activeLocale: 'en' },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.actions).toHaveLength(0);
    expect(result.value.results.navigate).toHaveLength(0);
  });

  it('respects the limit parameter for plan hits', async () => {
    // "o" matches "Gold" and "Diamond" (both have 'o'); limit=1 crops to 1
    const result = await searchPlans(
      { q: 'o', role: 'admin', activeLocale: 'en', limit: 1 },
      { tenant: tenant.ctx, planRepo, clock: fixedClock },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.plans).toHaveLength(1);
  });
});
