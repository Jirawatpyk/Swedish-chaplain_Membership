/**
 * 124 slice 1 — `?plan=<plan_id>` on the admin invoice list (the invoice
 * dashboard's Plan filter drills down with it). Any well-formed id filters
 * (`invoices.plan_id`, every plan year); the chip names the plan through
 * `resolvePlanName`'s locale fallback chain when the lookup knows it, else by
 * the id (another plan year, a failed lookup). Dropping an unknown id instead
 * would show the whole list unmarked; an id no invoice carries simply matches
 * nothing. Empty or over-long values are IGNORED.
 */
import { resolvePlanName } from '@/lib/resolve-plan-name';

export interface PlanFilter {
  readonly id: string;
  readonly label: string;
}

const MAX_PLAN_ID_LENGTH = 64;

/** The `?plan=` value the list filters by, or undefined when it is ignored. */
export function parsePlanIdParam(raw: string | undefined): string | undefined {
  return raw && raw.length <= MAX_PLAN_ID_LENGTH ? raw : undefined;
}

export function resolvePlanFilter(
  raw: string | undefined,
  plans: readonly { readonly plan_id: string; readonly plan_name: unknown }[] | undefined,
  locale: string,
): PlanFilter | undefined {
  const id = parsePlanIdParam(raw);
  if (!id) return undefined;
  const plan = plans?.find((p) => p.plan_id === id);
  return { id, label: plan ? resolvePlanName(plan.plan_name, id, locale) : id };
}
