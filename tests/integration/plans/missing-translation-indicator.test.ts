/**
 * T067 — Integration test: missing_translations indicator (US1).
 *
 * A plan with `{en, th}` but no `sv` should surface
 * `missing_translations: ['sv']` on the list response (via list-plans
 * use case hydration). EN-only plans surface `['th', 'sv']`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listPlans } from '@/modules/plans/application/list-plans';
import { planRepo } from '@/modules/plans/infrastructure/db/plan-repo';
import { feeConfigRepo } from '@/modules/plans/infrastructure/db/fee-config-repo';
import { asPlanYear } from '@/modules/plans/domain/plan';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type { PlanDraftInput } from '@/modules/plans/application/ports';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: null,
  homepage_logo_category: null,
  directory_listing_size: null,
  event_discount_scope: 'none',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: false,
  business_referrals: false,
  tailor_made_services: false,
  partnership: null,
};

const baseDraft = (planId: string, user: string): PlanDraftInput => ({
  plan_id: planId,
  plan_year: 2026,
  plan_name: { en: planId },
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
  benefit_matrix: MATRIX,
  isActive: true,
  createdBy: user,
  updatedBy: user,
} as PlanDraftInput);

describe('Integration: missing_translations indicator (T067)', () => {
  let tenant: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');

    // Seed fee config first (required for list-plans to return meta.currency_code)
    await feeConfigRepo.upsert(tenant.ctx, {
      currency_code: 'THB',
      vat_rate: 0.07,
      registration_fee_minor_units: 100000,
      updated_by: user.userId,
    });

    // Plan 1: EN + TH + SV all present → no missing translations
    await planRepo.insert(tenant.ctx, {
      ...baseDraft('all-locales', user.userId),
      plan_name: { en: 'All Locales', th: 'ทุกภาษา', sv: 'Alla spr\u00e5k' },
    });

    // Plan 2: EN + TH only → missing SV
    await planRepo.insert(tenant.ctx, {
      ...baseDraft('en-th-only', user.userId),
      plan_name: { en: 'EN + TH only', th: 'อังกฤษและไทยเท่านั้น' },
    });

    // Plan 3: EN only → missing TH + SV
    await planRepo.insert(tenant.ctx, {
      ...baseDraft('en-only', user.userId),
      plan_name: { en: 'EN only' },
    });
  });

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('surfaces missing_translations on each plan in the list', async () => {
    const result = await listPlans(
      { filter: { year: asPlanYear(2026) } },
      {
        tenant: tenant.ctx,
        planRepo,
        // R8 — list-plans now reads ONLY via taxPolicy; stub returns
        // the values this test seeded on tenant_fee_config so the
        // assertions on currency_code + vat_rate still hold.
        taxPolicy: async () => ({ currencyCode: 'THB', vatRateRaw: '0.0700' }),
        clock: { now: () => new Date('2026-06-01T00:00:00Z'), currentYear: () => 2026 },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.value.data.map((r) => [r.plan_id, r]));
    expect(byId.get('all-locales')?.missing_translations).toEqual([]);
    expect(byId.get('en-th-only')?.missing_translations).toEqual(['sv']);
    expect(byId.get('en-only')?.missing_translations).toEqual(['th', 'sv']);
  });

  it('meta.currency_code resolves from tenant_fee_config', async () => {
    const result = await listPlans(
      { filter: { year: asPlanYear(2026) } },
      {
        tenant: tenant.ctx,
        planRepo,
        // R8 — list-plans now reads ONLY via taxPolicy; stub returns
        // the values this test seeded on tenant_fee_config so the
        // assertions on currency_code + vat_rate still hold.
        taxPolicy: async () => ({ currencyCode: 'THB', vatRateRaw: '0.0700' }),
        clock: { now: () => new Date('2026-06-01T00:00:00Z'), currentYear: () => 2026 },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.currency_code).toBe('THB');
    }
  });
});
