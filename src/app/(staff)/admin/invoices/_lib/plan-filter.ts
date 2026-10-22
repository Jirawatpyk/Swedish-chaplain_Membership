/**
 * 124 slice 1 — `?plan=<plan_id>` on the admin invoice list (the invoice
 * dashboard's Plan filter drills down with it). A plan id the tenant has
 * resolves to the filter and its chip label (`resolvePlanName`'s locale
 * fallback chain); anything else is IGNORED (no 500, no restriction), like
 * every other list param.
 */
import { resolvePlanName } from '@/lib/resolve-plan-name';

export interface PlanFilter {
  readonly id: string;
  readonly label: string;
}

export function resolvePlanFilter(
  raw: string | undefined,
  plans: readonly { readonly plan_id: string; readonly plan_name: unknown }[],
  locale: string,
): PlanFilter | undefined {
  if (!raw) return undefined;
  const plan = plans.find((p) => p.plan_id === raw);
  if (!plan) return undefined;
  return { id: plan.plan_id, label: resolvePlanName(plan.plan_name, plan.plan_id, locale) };
}
