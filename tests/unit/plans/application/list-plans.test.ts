import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  listPlans,
  type ListPlansInput,
  type ListPlansDeps,
} from '@/modules/plans/application/list-plans';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear, type Plan } from '@/modules/plans/domain/plan';

const tenant = asTenantContext('swecham');
const NOW = new Date('2026-04-17T10:00:00.000Z');

const BASE_FEE_CONFIG = {
  tenant_id: 'swecham',
  vat_rate: 0.07,
  currency_code: 'THB' as const,
  updated_at: NOW,
  updated_by: 'seed',
};

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    tenant_id: 'swecham' as never,
    plan_id: asPlanSlug('corporate-standard'),
    plan_year: asPlanYear(2026),
    plan_name: { en: 'Corporate Standard', th: 'มาตรฐาน' },
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
    is_active: true,
    deleted_at: null,
    created_at: NOW,
    updated_at: NOW,
    created_by: 'seed',
    updated_by: 'seed',
    ...overrides,
  } as unknown as Plan;
}

interface FeeConfigOverride {
  readonly currency_code: string;
  readonly vat_rate: number;
}

function makeDeps(overrides: {
  feeConfig?: FeeConfigOverride | null | Error;
  plans?: Plan[] | Error;
  currentYear?: number;
} = {}): ListPlansDeps {
  return {
    tenant,
    planRepo: {
      findByTenantAndYear: vi.fn(async () => {
        const r = overrides.plans ?? [];
        if (r instanceof Error) throw r;
        return r;
      }),
      findOne: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      setActive: vi.fn(),
      softDelete: vi.fn(),
      undelete: vi.fn(),
      cloneYear: vi.fn(),
      countActiveForTenant: vi.fn(),
    },
    // R8 consolidation final — ListPlansDeps only carries `taxPolicy`
    // now; the legacy `feeConfigRepo` dep was removed. We drive the
    // same three scenarios the test file exercises (null / throw /
    // happy-path row) through the taxPolicy stub, mapping the
    // `feeConfig` override to a taxPolicy shape:
    //   null → taxPolicy returns null (→ fee_config_missing error)
    //   Error → taxPolicy throws (→ server_error)
    //   object → taxPolicy returns { currencyCode, vatRateRaw }
    //   undefined (default) → taxPolicy returns BASE_FEE_CONFIG values
    taxPolicy: vi.fn(async () => {
      if ('feeConfig' in overrides) {
        const r = overrides.feeConfig;
        if (r === null) return null;
        if (r instanceof Error) throw r;
        // Convert FeeConfigRow → taxPolicy shape.
        return {
          currencyCode: r.currency_code,
          vatRateRaw: r.vat_rate.toFixed(4),
        };
      }
      return {
        currencyCode: BASE_FEE_CONFIG.currency_code,
        vatRateRaw: BASE_FEE_CONFIG.vat_rate.toFixed(4),
      };
    }),
    clock: {
      now: vi.fn(() => NOW),
      currentYear: vi.fn(() => overrides.currentYear ?? 2026),
    },
  } as unknown as ListPlansDeps;
}

const baseInput: ListPlansInput = {
  filter: {},
};

describe('listPlans use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns fee_config_missing when feeConfig is null', async () => {
    const deps = makeDeps({ feeConfig: null });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('fee_config_missing');
    expect(deps.planRepo.findByTenantAndYear).not.toHaveBeenCalled();
  });

  it('returns server_error when feeConfigRepo throws', async () => {
    const deps = makeDeps({ feeConfig: new Error('Config DB down') });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') expect(result.error.message).toBe('Config DB down');
    }
  });

  it('returns server_error when planRepo throws', async () => {
    const deps = makeDeps({ plans: new Error('Plans DB down') });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns empty data with correct meta on no plans', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toHaveLength(0);
      expect(result.value.meta.total).toBe(0);
      expect(result.value.meta.currency_code).toBe('THB');
      expect(result.value.meta.year).toBe(2026);
    }
  });

  it('hydrates VAT correctly (total = fee * (1 + vat_rate))', async () => {
    const plan = makePlan({ annual_fee_minor_units: 1_000_000 });
    const deps = makeDeps({ plans: [plan] });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const item = result.value.data[0]!;
      expect(item.annual_fee_minor_units).toBe(1_000_000);
      expect(item.vat_rate).toBe(0.07);
      expect(item.total_with_vat_minor_units).toBe(1_070_000);
    }
  });

  // N2 (review 2026-04-19 21:19) — integer-only gross amount. Pin
  // a non-7 % VAT rate on a fee amount where float arithmetic
  // (`Math.round(fee * (1 + Number(rate)))`) would round incorrectly.
  // 8.5 % × 1_234_567 satang:
  //   exact = 1 234 567 × 108 500 / 100 000 = 133 999 516 / 100 =
  //   1 339 995.16 → rounded half-up = 1 339 995 satang.
  // With float:
  //   Number('0.0850') * 1_234_567 = 104 938.195 (binary-rounded),
  //   fee * (1 + rate) = 1 339 504.195 → Math.round → 1 339 504. Off by 491.
  // We assert the integer path returns the exact value.
  it('N2: integer gross for 8.5 % VAT on 1_234_567 satang = 1_339_505', async () => {
    const plan = makePlan({ annual_fee_minor_units: 1_234_567 });
    const deps = makeDeps({
      plans: [plan],
      feeConfig: { currency_code: 'THB', vat_rate: 0.085 },
    });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const item = result.value.data[0]!;
      // Exact gross via integer math:
      // 1_234_567 * (10_000 + 850) / 10_000, half-up.
      // = 13_394_950.795 → rounded = 1_339_505.
      expect(item.total_with_vat_minor_units).toBe(1_339_505);
    }
  });

  it('serialises deleted_at to ISO string when set', async () => {
    const plan = makePlan({ deleted_at: NOW });
    const deps = makeDeps({ plans: [plan] });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data[0]!.deleted_at).toBe(NOW.toISOString());
    }
  });

  it('returns null deleted_at when not deleted', async () => {
    const plan = makePlan({ deleted_at: null });
    const deps = makeDeps({ plans: [plan] });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data[0]!.deleted_at).toBeNull();
    }
  });

  it('uses current year from clock when filter.year is not provided', async () => {
    const deps = makeDeps({ currentYear: 2027, plans: [] });
    const result = await listPlans({ filter: {} }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.meta.year).toBe(2027);
  });

  it('defaults filter nulls in meta when not provided', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await listPlans({ filter: {} }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.filter.category).toBeNull();
      expect(result.value.meta.filter.q).toBeNull();
      expect(result.value.meta.filter.activeOnly).toBe(false);
      expect(result.value.meta.filter.showDeleted).toBe(false);
    }
  });

  it('reflects filter values in meta', async () => {
    const deps = makeDeps({ plans: [] });
    const result = await listPlans({
      filter: { category: 'corporate', q: 'standard', activeOnly: true, showDeleted: true },
    }, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.meta.filter.category).toBe('corporate');
      expect(result.value.meta.filter.q).toBe('standard');
      expect(result.value.meta.filter.activeOnly).toBe(true);
      expect(result.value.meta.filter.showDeleted).toBe(true);
    }
  });

  it('surfaces missing_translations for plans lacking th/sv names', async () => {
    const plan = makePlan({ plan_name: { en: 'English Only' } as Plan['plan_name'] });
    const deps = makeDeps({ plans: [plan] });
    const result = await listPlans(baseInput, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data[0]!.missing_translations).toContain('th');
      expect(result.value.data[0]!.missing_translations).toContain('sv');
    }
  });
});
