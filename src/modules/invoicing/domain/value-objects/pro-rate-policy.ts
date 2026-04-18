/**
 * T027 — ProRatePolicy value object (F4).
 * Mirrors DB enum `pro_rate_policy`.
 */

export const PRO_RATE_POLICIES = ['none', 'monthly', 'daily'] as const;
export type ProRatePolicy = (typeof PRO_RATE_POLICIES)[number];

export function isProRatePolicy(value: string): value is ProRatePolicy {
  return (PRO_RATE_POLICIES as readonly string[]).includes(value);
}

export function asProRatePolicyUnsafe(value: string): ProRatePolicy {
  if (!isProRatePolicy(value)) throw new Error(`ProRatePolicy.asProRatePolicyUnsafe: invalid ${value}`);
  return value;
}
