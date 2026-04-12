/**
 * Shared plan response serialiser — single source of truth for the
 * JSON envelope shape returned by every plan API endpoint.
 *
 * Converts `Date` fields to ISO 8601 strings and `null`-coalesces
 * `deleted_at`. Previously copy-pasted across 7 route handlers.
 */

import type { Plan } from '@/modules/plans';

export function serialisePlan(plan: Plan) {
  return {
    plan_id: plan.plan_id,
    plan_year: plan.plan_year,
    plan_name: plan.plan_name,
    description: plan.description,
    sort_order: plan.sort_order,
    plan_category: plan.plan_category,
    member_type_scope: plan.member_type_scope,
    annual_fee_minor_units: plan.annual_fee_minor_units,
    includes_corporate_plan_id: plan.includes_corporate_plan_id,
    min_turnover_minor_units: plan.min_turnover_minor_units,
    max_turnover_minor_units: plan.max_turnover_minor_units,
    max_duration_years: plan.max_duration_years,
    max_member_age: plan.max_member_age,
    benefit_matrix: plan.benefit_matrix,
    is_active: plan.is_active,
    deleted_at: plan.deleted_at?.toISOString() ?? null,
    created_at: plan.created_at.toISOString(),
    updated_at: plan.updated_at.toISOString(),
  };
}
