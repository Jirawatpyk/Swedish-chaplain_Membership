/**
 * WP3 — partition the portal renewal plan options into upgrade / current /
 * downgrade buckets for the grouped <SelectGroup> blocks.
 *
 * Generic over `{ planId; annualFeeMinorUnits }` so it stays decoupled from
 * the `RenewalPlanOption` shape (which WP5 extends). The bucketing uses the
 * SAME `classifyPlanPriceChange` predicate the downgrade gate uses, so the
 * "Lower-priced plans" group holds exactly the plans that will trigger the
 * downgrade acknowledgement dialog.
 *
 * A same-priced non-current alternative (rare — the catalogue prices are
 * distinct) is NOT a downgrade, so it lands in the higher-priced ("upgrade")
 * bucket rather than the downgrade one; only strictly-cheaper plans need an
 * ack. Input order is preserved within each bucket.
 */
import { classifyPlanPriceChange } from '@/modules/renewals/client';

export interface GroupedPlanOptions<T> {
  readonly upgrade: readonly T[];
  readonly current: readonly T[];
  readonly downgrade: readonly T[];
}

export function groupPlanOptions<
  T extends { readonly planId: string; readonly annualFeeMinorUnits: number },
>(input: {
  readonly plans: readonly T[];
  readonly currentPlanId: string;
  readonly currentPriceMinorUnits: number;
}): GroupedPlanOptions<T> {
  const upgrade: T[] = [];
  const current: T[] = [];
  const downgrade: T[] = [];

  for (const plan of input.plans) {
    if (plan.planId === input.currentPlanId) {
      current.push(plan);
      continue;
    }
    const change = classifyPlanPriceChange({
      currentMinorUnits: input.currentPriceMinorUnits,
      targetMinorUnits: plan.annualFeeMinorUnits,
    });
    if (change === 'downgrade') {
      downgrade.push(plan);
    } else {
      upgrade.push(plan);
    }
  }

  return { upgrade, current, downgrade };
}
