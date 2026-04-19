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
  /**
   * R8 consolidation final — authoritative tenant tax policy source,
   * reads `tenant_invoice_settings.vat_rate` + `.currency_code` via
   * the F4 `getTenantTaxPolicy` facade wired in the composition root.
   * Migration 0028 backfilled invoice_settings rows for every tenant
   * that had a fee_config row, so `null` here means a truly
   * un-onboarded tenant (no fee_config either) — bootstrap error.
   */
  readonly taxPolicy: () => Promise<{
    readonly currencyCode: string;
    readonly vatRateRaw: string; // "0.0700"
  } | null>;
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

    // R8 consolidation final — `tenant_invoice_settings` is the sole
    // authoritative source. Migration 0028 guarantees every tenant
    // with a pre-existing `tenant_fee_config` row also has an
    // `invoice_settings` row. A null return here means the tenant is
    // un-onboarded — surface the same bootstrap error type as pre-R8
    // so API consumers don't have to switch.
    const tax = await deps.taxPolicy();
    if (!tax) {
      return err({ type: 'fee_config_missing' });
    }
    const currencyCode = tax.currencyCode;
    const vatRateNumber = Number(tax.vatRateRaw);

    // N2 (review 2026-04-19 21:19) — integer-only gross-amount math.
    // `vatRateRaw` is a 4-dp decimal string ("0.0700" for 7%). Parsing
    // via `Number` + multiplying by a fee introduces IEEE-754 rounding
    // for non-binary-clean rates (8.5%, 10%, 13.5%). Thai-tax amounts
    // are legal figures (FR-002 / FR-005) — compute gross = fee *
    // (10000 + numerator) / 10000 with half-up rounding in `bigint`.
    const [, vatFrac] = tax.vatRateRaw.split('.');
    const vatNumerator = BigInt(vatFrac ?? '0'); // "0700" → 700n
    const VAT_SCALE = 10_000n;

    // Load plans via repo — RLS scopes by tenant; no explicit tenant_id filter.
    const plans = await deps.planRepo.findByTenantAndYear(deps.tenant, {
      ...input.filter,
      year,
    });

    // Hydrate display envelope per plan
    const data: PlanListItem[] = plans.map((p) => {
      const fee = p.annual_fee_minor_units;
      const feeBn = BigInt(fee);
      const totalWithVat = Number(
        (feeBn * (VAT_SCALE + vatNumerator) + VAT_SCALE / 2n) / VAT_SCALE,
      );
      return {
        plan_id: p.plan_id,
        plan_year: p.plan_year,
        plan_name: p.plan_name,
        description: p.description,
        plan_category: p.plan_category,
        member_type_scope: p.member_type_scope,
        annual_fee_minor_units: fee,
        vat_rate: vatRateNumber,
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
        currency_code: currencyCode as CurrencyCode,
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
