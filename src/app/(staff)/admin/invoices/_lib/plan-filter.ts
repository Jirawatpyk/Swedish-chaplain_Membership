/**
 * 124 slice 1 — `?plan=<plan_id>` on the admin invoice list (the invoice
 * dashboard's Plan filter drills down with it). A plan id the tenant has
 * resolves to the filter and its chip label, in the viewer's locale with
 * English, then the id, as fallback; anything else is IGNORED (no 500, no
 * restriction), like every other list param.
 */
export interface PlanFilter {
  readonly id: string;
  readonly label: string;
}

interface PlanLike {
  readonly plan_id: string;
  readonly plan_name: Readonly<Record<string, string | undefined>>;
}

export function resolvePlanFilter(
  raw: string | undefined,
  plans: readonly PlanLike[],
  locale: string,
): PlanFilter | undefined {
  if (!raw) return undefined;
  const plan = plans.find((p) => p.plan_id === raw);
  if (!plan) return undefined;
  return { id: plan.plan_id, label: plan.plan_name[locale] ?? plan.plan_name.en ?? plan.plan_id };
}
