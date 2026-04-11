/**
 * `list-plans` use case (T072, US1 FR-005 / FR-006).
 *
 * Loads plans for the active tenant + filter, hydrates a display
 * envelope (currency-formatted fee, VAT-inclusive total, missing
 * translation indicator), and returns the result envelope the
 * API route serialises verbatim per contracts/plans-api.md § 1.
 *
 * Pure Application logic — no Drizzle, no Next, no React imports.
 * Talks to Infrastructure only through injected ports (`PlanRepo`,
 * `FeeConfigRepo`, `ClockPort`).
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  ClockPort,
  FeeConfigRepo,
  ListPlansFilter,
  PlanRepo,
} from './ports';
import type { Plan, PlanCategory } from '../domain/plan';
import { asPlanYear } from '../domain/plan';
import { hasMissingTranslations, type LocaleKey } from '../domain/locale-text';
import type { CurrencyCode } from '../domain/money';

// --- Input / output types ----------------------------------------------------

export type ListPlansInput = {
  readonly filter: ListPlansFilter;
};

export type PlanListItem = {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly plan_name: Plan['plan_name'];
  readonly description: Plan['description'];
  readonly plan_category: PlanCategory;
  readonly member_type_scope: Plan['member_type_scope'];
  readonly annual_fee_minor_units: number;
  readonly vat_rate: number;
  readonly total_with_vat_minor_units: number;
  readonly includes_corporate_plan_id: string | null;
  readonly is_active: boolean;
  readonly deleted_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly sort_order: number;
  readonly missing_translations: ReadonlyArray<Exclude<LocaleKey, 'en'>>;
};

export type ListPlansSuccess = {
  readonly data: ReadonlyArray<PlanListItem>;
  readonly meta: {
    readonly total: number;
    readonly year: number;
    readonly currency_code: CurrencyCode;
    readonly filter: {
      readonly category: PlanCategory | null;
      readonly q: string | null;
      readonly activeOnly: boolean;
      readonly showDeleted: boolean;
    };
  };
};

export type ListPlansError =
  | { readonly type: 'fee_config_missing' }
  | { readonly type: 'server_error'; readonly message: string };

export type ListPlansDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly clock: ClockPort;
};

// --- Implementation ----------------------------------------------------------

export async function listPlans(
  input: ListPlansInput,
  deps: ListPlansDeps,
): Promise<Result<ListPlansSuccess, ListPlansError>> {
  try {
    // Default year = current year (Gregorian)
    const year =
      input.filter.year ?? asPlanYear(deps.clock.currentYear());

    // Load fee config first — we need vat_rate + currency_code to
    // hydrate Money-related fields. Fee config missing is a bootstrap
    // error (every onboarded tenant should have one row).
    const feeConfig = await deps.feeConfigRepo.findByTenant(deps.tenant);
    if (!feeConfig) {
      return err({ type: 'fee_config_missing' });
    }

    // Load plans via repo — RLS scopes by tenant; no explicit tenant_id filter.
    const plans = await deps.planRepo.findByTenantAndYear(deps.tenant, {
      ...input.filter,
      year,
    });

    // Hydrate display envelope per plan
    const data: PlanListItem[] = plans.map((p) => {
      const fee = p.annual_fee_minor_units;
      const totalWithVat = Math.round(fee * (1 + feeConfig.vat_rate));
      return {
        plan_id: p.plan_id,
        plan_year: p.plan_year,
        plan_name: p.plan_name,
        description: p.description,
        plan_category: p.plan_category,
        member_type_scope: p.member_type_scope,
        annual_fee_minor_units: fee,
        vat_rate: feeConfig.vat_rate,
        total_with_vat_minor_units: totalWithVat,
        includes_corporate_plan_id: p.includes_corporate_plan_id,
        is_active: p.is_active,
        deleted_at: p.deleted_at ? p.deleted_at.toISOString() : null,
        created_at: p.created_at.toISOString(),
        updated_at: p.updated_at.toISOString(),
        sort_order: p.sort_order,
        missing_translations: hasMissingTranslations(p.plan_name),
      };
    });

    return ok({
      data,
      meta: {
        total: data.length,
        year: year as number,
        currency_code: feeConfig.currency_code,
        filter: {
          category: input.filter.category ?? null,
          q: input.filter.q ?? null,
          activeOnly: input.filter.activeOnly ?? false,
          showDeleted: input.filter.showDeleted ?? false,
        },
      },
    });
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
