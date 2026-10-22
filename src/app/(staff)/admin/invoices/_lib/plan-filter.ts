/**
 * 124 slice 1 — `?plan=<plan_id>` on the admin invoice list (the invoice
 * dashboard's Plan filter drills down with it). A plan id the tenant has
 * resolves to the filter and its chip label (`resolvePlanName`'s locale
 * fallback chain); an unknown id is IGNORED (no 500, no restriction), like
 * every other list param.
 *
 * When the plan lookup itself failed (`plans` undefined) a plausible id still
 * filters, its chip named by the id: dropping it would show the whole list
 * as if it were the plan's, with nothing on screen to say so.
 */
import { resolvePlanName } from '@/lib/resolve-plan-name';

export interface PlanFilter {
  readonly id: string;
  readonly label: string;
}

const MAX_PLAN_ID_LENGTH = 64;

export function resolvePlanFilter(
  raw: string | undefined,
  plans: readonly { readonly plan_id: string; readonly plan_name: unknown }[] | undefined,
  locale: string,
): PlanFilter | undefined {
  if (!raw) return undefined;
  if (plans === undefined) {
    return raw.length <= MAX_PLAN_ID_LENGTH ? { id: raw, label: raw } : undefined;
  }
  const plan = plans.find((p) => p.plan_id === raw);
  if (!plan) return undefined;
  return { id: plan.plan_id, label: resolvePlanName(plan.plan_name, plan.plan_id, locale) };
}
