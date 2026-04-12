/**
 * `Plan` — the authoritative in-code representation of a membership plan.
 *
 * See data-model.md § 2.1. Branded types (`PlanSlug`, `PlanYear`,
 * `TenantSlug`) prevent accidentally passing a raw string / number at
 * API boundaries or between tenants.
 *
 * This file is pure Domain — no framework imports.
 */

import type { BenefitMatrix } from './benefit-matrix';
import type { LocaleText } from './locale-text';

// --- Branded identity types ---------------------------------------------------

const planSlugBrand = Symbol('PlanSlug');
const planYearBrand = Symbol('PlanYear');
const tenantSlugBrand = Symbol('TenantSlug');

export type PlanSlug = string & { readonly [planSlugBrand]: true };
export type PlanYear = number & { readonly [planYearBrand]: true };
export type TenantSlug = string & { readonly [tenantSlugBrand]: true };

/** Construct a validated `PlanSlug` — 1..63 chars of `[a-z0-9-]`. */
export function asPlanSlug(value: string): PlanSlug {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,63}$/.test(value)) {
    throw new Error(`Invalid plan slug: ${JSON.stringify(value)}`);
  }
  return value as PlanSlug;
}

/** Construct a validated `PlanYear` — integer in `[2000, 2100]`. */
export function asPlanYear(value: number): PlanYear {
  if (!Number.isInteger(value) || value < 2000 || value > 2100) {
    throw new Error(
      `Invalid plan year: ${value}. Must be an integer in [2000, 2100].`,
    );
  }
  return value as PlanYear;
}

/** Construct a validated `TenantSlug` — matches TENANT_SLUG_PATTERN. */
export function asTenantSlug(value: string): TenantSlug {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,63}$/.test(value)) {
    throw new Error(`Invalid tenant slug: ${JSON.stringify(value)}`);
  }
  return value as TenantSlug;
}

// --- Classification enums -----------------------------------------------------

export const PLAN_CATEGORIES = ['corporate', 'partnership'] as const;
export type PlanCategory = (typeof PLAN_CATEGORIES)[number];

export const MEMBER_TYPE_SCOPES = ['company', 'individual', 'both'] as const;
export type MemberTypeScope = (typeof MEMBER_TYPE_SCOPES)[number];

/** Narrow `PlanCategory` exhaustiveness check helper. */
export function isPlanCategory(value: unknown): value is PlanCategory {
  return (
    typeof value === 'string' &&
    (PLAN_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isMemberTypeScope(value: unknown): value is MemberTypeScope {
  return (
    typeof value === 'string' &&
    (MEMBER_TYPE_SCOPES as readonly string[]).includes(value)
  );
}

// --- Plan entity --------------------------------------------------------------

/**
 * Domain `Plan` — matches the shape persisted in `membership_plans`
 * but using branded types + strict Domain sub-types.
 *
 * `tenant_id` / `plan_id` / `plan_year` form the composite primary key.
 * Infrastructure repos translate to/from snake_case columns via Drizzle.
 *
 * Money fields use integer minor units only (see `money.ts`). Currency
 * lives once per tenant on `TenantFeeConfig.currency_code` — no
 * per-plan currency column exists in F2 (critique P3).
 */
export type Plan = {
  // Identity
  readonly tenant_id: TenantSlug;
  readonly plan_id: PlanSlug;
  readonly plan_year: PlanYear;

  // Display & ordering
  readonly plan_name: LocaleText;
  readonly description: LocaleText;
  readonly sort_order: number;

  // Classification
  readonly plan_category: PlanCategory;
  readonly member_type_scope: MemberTypeScope;

  // Pricing — integer minor units only
  readonly annual_fee_minor_units: number;

  // Partnership → Corporate bundling
  readonly includes_corporate_plan_id: PlanSlug | null;

  // Eligibility (all optional)
  readonly min_turnover_minor_units: number | null;
  readonly max_turnover_minor_units: number | null;
  readonly max_duration_years: number | null;
  readonly max_member_age: number | null;

  // Benefits
  readonly benefit_matrix: BenefitMatrix;

  // State
  readonly is_active: boolean;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly created_by: string; // UUID from F1 users
  readonly updated_by: string; // UUID from F1 users
};
