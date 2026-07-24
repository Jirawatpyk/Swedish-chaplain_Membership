/**
 * Plan price-change classifier (WP3 keystone).
 *
 * A member renewing may switch to a different plan. Whether that switch is
 * an upgrade, a sidegrade, or a downgrade is decided by a SINGLE predicate
 * shared by the client (portal renewal grouping + the downgrade
 * acknowledgement dialog) and the server (`confirmRenewal`'s downgrade
 * refusal). Sharing one classifier is the whole point — the client warning
 * and the server gate cannot disagree.
 *
 * Correction C-5 — the currency axis is DROPPED. Chamber-OS renewal money is
 * THB throughout (`RenewalCycle.frozenPlanCurrency` is the literal `'THB'`),
 * so both sides hand this function two THB-satang integers and nothing else.
 * A currency argument existed only in an earlier blueprint and was itself the
 * divergence risk (the client had no currency to pass while the server did),
 * so it is gone. Compare two satang numbers, full stop.
 *
 * Pure Domain — ZERO imports (Constitution Principle III). 100% branch
 * coverage is enforced by the domain blanket; there are no unreachable arms.
 */

/** The three price relationships between a member's current and target plan. */
export type PlanPriceChange = 'upgrade' | 'same' | 'downgrade';

/**
 * Classify a plan switch by comparing the target plan's price to the
 * member's current (frozen) price, both in THB satang (minor units).
 *
 * A strict `<` / `>` comparison — a `0` target against a non-zero current is
 * a genuine downgrade, not a falsy edge case.
 */
export function classifyPlanPriceChange(input: {
  readonly currentMinorUnits: number;
  readonly targetMinorUnits: number;
}): PlanPriceChange {
  if (input.targetMinorUnits < input.currentMinorUnits) return 'downgrade';
  if (input.targetMinorUnits > input.currentMinorUnits) return 'upgrade';
  return 'same';
}

/**
 * A downgrade — and ONLY a downgrade — requires the member's explicit
 * two-step acknowledgement (they lose benefits + pay less). An upgrade or a
 * same-price sidegrade proceeds without a confirmation gate.
 */
export function requiresDowngradeAck(change: PlanPriceChange): boolean {
  return change === 'downgrade';
}
