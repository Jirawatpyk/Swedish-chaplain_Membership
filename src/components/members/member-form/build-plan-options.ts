/**
 * WP2 — `PlanListItem[] → PlanOption[]` mapper for the member-form plan picker.
 *
 * Single source of truth (was duplicated + hardcoded `.en` at both admin
 * member pages — `/admin/members/new` + `/admin/members/[id]/edit` — which
 * silently dropped TH/SV on the plan label, P1-8). Resolves the localised
 * plan name via the promoted `resolvePlanName`, threads the annual fee +
 * currency + category so the picker can surface the price, and keeps the
 * DOB-required proxy (`individual`-scoped plans).
 *
 * Pure mapper — no framework/server imports (type-only barrel imports are
 * erased), so it is safe to call from a Server Component while the produced
 * `PlanOption` stays a plain client-serialisable object.
 */
import type { PlanCategory } from '@/modules/plans';
import { resolvePlanName } from '@/lib/resolve-plan-name';
import type { PlanOption } from './schema';

/**
 * The subset of an F2 `listPlans` row (`PlanListItem`) this mapper reads.
 * Declared structurally (not imported from the plans module) so passing the
 * full `ReadonlyArray<PlanListItem>` from the page satisfies it without
 * coupling the client-adjacent form to the plans Application layer.
 */
export interface PlanRowForOptions {
  readonly plan_id: string;
  readonly plan_year: number;
  /** JSONB `LocaleText`-shaped name — passed to `resolvePlanName` as `unknown`. */
  readonly plan_name: unknown;
  readonly member_type_scope: string;
  readonly annual_fee_minor_units: number;
  readonly plan_category: PlanCategory;
}

export function buildPlanOptions(
  rows: ReadonlyArray<PlanRowForOptions>,
  locale: string,
  currencyCode: string,
): PlanOption[] {
  return rows.map((p) => ({
    plan_id: p.plan_id,
    plan_year: p.plan_year,
    // Locale-aware name + the year suffix the picker + confirm dialog rely on.
    display_name: `${resolvePlanName(p.plan_name, p.plan_id, locale)} — ${p.plan_year}`,
    // Individual-scoped plans (e.g. Thai Alumni) require DOB. A proxy for the
    // authoritative server-side age-eligibility policy — this UI hint only
    // prompts for DOB upfront.
    requires_date_of_birth: p.member_type_scope === 'individual',
    annual_fee_minor_units: p.annual_fee_minor_units,
    currency_code: currencyCode,
    plan_category: p.plan_category,
  }));
}
