/**
 * The codes a tier E-Blast may target: the two `plan_category` values the
 * recipient query matches (case-sensitive). Spec 122 PR D (27 Oct 2026,
 * FR-011): the picker offers only these, and the submit and count routes
 * refuse anything else, because any other code reached nobody.
 *
 * Client-safe (no server imports; `PLAN_CATEGORIES` lives in the plans
 * domain, so a test pins the two lists equal): the picker, the history and the routes
 * share this one list. The compose hint ("Choose one or both.") assumes two:
 * adding a code means re-wording `portal.broadcasts.compose.fields.tierCodesHelp`.
 */
import { z } from 'zod';

export const BROADCAST_TIER_CODES = ['corporate', 'partnership'] as const;

export type BroadcastTierCode = (typeof BROADCAST_TIER_CODES)[number];

export function isBroadcastTierCode(code: string): code is BroadcastTierCode {
  return (BROADCAST_TIER_CODES as readonly string[]).includes(code);
}

/**
 * The one guard for a tier segment's codes, shared by both submit routes and
 * the recipient count so they cannot drift (security review L-1/L-2): at
 * least one, each a category, each once.
 */
export const broadcastTierCodesSchema = z
  .array(z.enum(BROADCAST_TIER_CODES))
  .min(1)
  .refine((codes) => new Set(codes).size === codes.length, 'duplicate tier code');
