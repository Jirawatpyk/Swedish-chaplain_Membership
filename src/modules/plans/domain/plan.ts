/**
 * `Plan` — the authoritative in-code representation of a membership plan.
 *
 * See data-model.md § 2.1. Branded types `PlanSlug` + `PlanYear` prevent
 * accidentally passing a raw string / number at API boundaries.
 * `TenantSlug` is re-exported from `@/modules/tenants` so all features
 * share a single nominal type (deleted the local duplicate brand
 * 2026-05-02 — F2 and F7 had separate `Symbol('TenantSlug')` brands
 * that were structurally compatible but nominally distinct, blocking
 * cross-feature passing without unsafe casts).
 *
 * This file is pure Domain — no framework imports.
 */

import { asTenantSlug, type TenantSlug } from '@/modules/tenants';

import type { BenefitMatrix } from './benefit-matrix';
import type { LocaleText } from './locale-text';

// --- Branded identity types ---------------------------------------------------

const planSlugBrand = Symbol('PlanSlug');
const planYearBrand = Symbol('PlanYear');

export type PlanSlug = string & { readonly [planSlugBrand]: true };
export type PlanYear = number & { readonly [planYearBrand]: true };
export type { TenantSlug };
export { asTenantSlug };

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

// --- Advisory-lock key builders -----------------------------------------------

/**
 * Build the shared Postgres advisory-lock key used by BOTH sides of the
 * soft-delete / member-assign TOCTOU race (W0-02).
 *
 * Lock key format: `plans:softdelete:<tenantSlug>:<planId>:<planYear>`
 *
 * Namespace `plans:softdelete:` is deliberately distinct from:
 *   - `plans:clone:`        — cloneYear in plan-repo.ts
 *   - `invoicing:`          — F4 sequential numbering
 *   - `payments:`           — F5 concurrent-initiate guard
 *   - `broadcasts:`         — F7 broadcast dispatch
 *   - `broadcasts-batch:`   — F7 batch dispatch
 *   - `renewals:`           — F8 renewal-cycle locking
 *   - `eventcreate-quota:`  — F6 seat allocation
 *
 * This function lives in Domain (pure — no drizzle/ORM/framework imports)
 * so it can be imported by both:
 *   - The plans module's infrastructure (soft-delete-guarded repo method)
 *   - The members module (changePlan advisory-lock acquirer)
 * via the plans public barrel `@/modules/plans`.
 *
 * The FORMAT is the single source of truth — NO string literals elsewhere.
 */
export function planSoftDeleteLockKey(
  tenantSlug: string,
  planId: string,
  planYear: number,
): string {
  return `plans:softdelete:${tenantSlug}:${planId}:${planYear}`;
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
 * is resolved per tenant via F4 `getTenantTaxPolicy` (reading
 * `tenant_invoice_settings` — R8 consolidation, post-migration 0029).
 * No per-plan currency column exists in F2 (critique P3).
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
