/**
 * The codes a tier E-Blast may target: the two `plan_category` values the
 * recipient query matches (case-sensitive). Spec 122 PR D (27 Oct 2026,
 * FR-011): the picker offers only these, and the submit and count routes
 * refuse anything else, because any other code reached nobody.
 *
 * Client-safe (no server imports): the picker, the history and the routes
 * share this one list.
 */
export const BROADCAST_TIER_CODES = ['corporate', 'partnership'] as const;

export type BroadcastTierCode = (typeof BROADCAST_TIER_CODES)[number];

export function isBroadcastTierCode(code: string): code is BroadcastTierCode {
  return (BROADCAST_TIER_CODES as readonly string[]).includes(code);
}
