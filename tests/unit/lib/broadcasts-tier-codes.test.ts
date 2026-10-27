/**
 * Spec 122 PR D (/code-review) — the E-Blast tier codes are the plans
 * domain's `plan_category` values. The broadcast list is client-safe and kept
 * apart from the plans module, so this pins the two equal: a new category
 * must reach the picker and the routes, not be refused by them silently.
 */
import { describe, expect, it } from 'vitest';
import { PLAN_CATEGORIES } from '@/modules/plans';
import { BROADCAST_TIER_CODES, broadcastTierCodesSchema } from '@/lib/broadcasts-tier-codes';

describe('BROADCAST_TIER_CODES', () => {
  it('are the plan categories', () => {
    expect([...BROADCAST_TIER_CODES]).toEqual([...PLAN_CATEGORIES]);
  });

  it.each([
    [[], false],
    [['corporate'], true],
    [['corporate', 'partnership'], true],
    [['corporate', 'corporate'], false],
    [['premium'], false],
  ])('the schema on %j → %s', (codes, ok) => {
    expect(broadcastTierCodesSchema.safeParse(codes).success).toBe(ok);
  });
});
