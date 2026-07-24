/**
 * WP7 (BP5 item 6) — resolve a bundle corporate-plan slug to a human name.
 *
 * The bundle-change warning dialog historically rendered the raw
 * `corporate_plan_id` (a font-mono UUID). This resolves it to the plan's
 * `display_name` by matching on the **(plan_id, plan_year)** pair (C-16) — the
 * same-id-across-years hazard applies here too. Returns `null` when the id is
 * absent, or when it exists only under a different year (→ the caller falls
 * back to the font-mono id, exactly the pre-existing behaviour).
 */
import type { PlanOption } from './member-form/schema';

export function resolveBundlePlanLabel(
  plans: readonly PlanOption[],
  planId: string | null,
  planYear: number,
): string | null {
  if (planId === null) return null;
  const match = plans.find(
    (p) => p.plan_id === planId && p.plan_year === planYear,
  );
  return match?.display_name ?? null;
}
