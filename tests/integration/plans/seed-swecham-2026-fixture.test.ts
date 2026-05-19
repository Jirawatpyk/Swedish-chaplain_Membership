/**
 * Post-ship R6 I5 — SC-005 SweCham 2026 seed fixture compliance test.
 *
 * Asserts the seed script's canonical data matches spec SC-005:
 *   - Exactly 9 plans (6 corporate + 3 partnership)
 *   - Corporate fee table (THB minor units / satang) matches
 *     `[3_600_000, 2_600_000, 1_600_000, 1_000_000, 600_000, 100_000]`
 *   - Partnership fee table matches `[20_000_000, 15_000_000, 10_000_000]`
 *     (Diamond / Platinum / Gold)
 *   - Every plan has tri-locale name (en + th + sv), no empty `en`
 *   - Corporate plan IDs match `[premium, large, regular, start-up,
 *     individual, thai-alumni]` (canonical fixture identifiers)
 *   - Partnership plan IDs match `[diamond, platinum, gold]`
 *   - Plan IDs are unique within each tier
 *   - `sortOrder` is strictly increasing within each tier
 *
 * Notes
 *   - This is a fixture-shape compliance test — it does NOT run the
 *     seed script (which requires TENANT_SLUG=swecham + a bootstrap
 *     admin user). The seed script's main() invocation is now guarded
 *     by `isCliEntry` so importing the exported constants is
 *     side-effect-free (see post-ship R6 I5 refactor 2026-05-19).
 *   - Idempotency, audit-event emission, and DB state are exercised
 *     by other integration tests (`clone-idempotency.test.ts` covers
 *     the cloneYear flow; the seed script's `count > 0` skip is
 *     trivially correct given the production guard).
 */
import { describe, expect, it } from 'vitest';
import {
  CORPORATE_SEED,
  PARTNERSHIP_SEED,
} from '../../../scripts/seed-swecham-2026-plans';

const EXPECTED_CORPORATE_FEES = [
  3_600_000, // premium
  2_600_000, // large
  1_600_000, // regular
  1_000_000, // start-up
  600_000, // individual
  100_000, // thai-alumni
] as const;

const EXPECTED_PARTNERSHIP_FEES = [
  20_000_000, // diamond
  15_000_000, // platinum
  10_000_000, // gold
] as const;

const EXPECTED_CORPORATE_IDS = [
  'premium',
  'large',
  'regular',
  'start-up',
  'individual',
  'thai-alumni',
] as const;

const EXPECTED_PARTNERSHIP_IDS = ['diamond', 'platinum', 'gold'] as const;

describe('SC-005 — SweCham 2026 seed fixture compliance (post-ship R6 I5)', () => {
  it('seed has exactly 9 plans across 6 corporate + 3 partnership', () => {
    expect(CORPORATE_SEED).toHaveLength(6);
    expect(PARTNERSHIP_SEED).toHaveLength(3);
    expect(CORPORATE_SEED.length + PARTNERSHIP_SEED.length).toBe(9);
  });

  it('corporate fee table matches canonical SweCham 2026 PDF values', () => {
    const fees = CORPORATE_SEED.map((p) => p.fee);
    expect(fees).toEqual(EXPECTED_CORPORATE_FEES);
  });

  it('partnership fee table matches canonical SweCham 2026 PDF values', () => {
    const fees = PARTNERSHIP_SEED.map((p) => p.fee);
    expect(fees).toEqual(EXPECTED_PARTNERSHIP_FEES);
  });

  it('corporate plan IDs match the canonical fixture order', () => {
    const ids = CORPORATE_SEED.map((p) => p.id);
    expect(ids).toEqual(EXPECTED_CORPORATE_IDS);
  });

  it('partnership plan IDs match the canonical fixture order', () => {
    const ids = PARTNERSHIP_SEED.map((p) => p.id);
    expect(ids).toEqual(EXPECTED_PARTNERSHIP_IDS);
  });

  it('every plan has tri-locale name (en + th + sv) with non-empty en', () => {
    for (const plan of [...CORPORATE_SEED, ...PARTNERSHIP_SEED]) {
      expect(plan.name.en).toBeTruthy();
      expect(plan.name.en.length).toBeGreaterThan(0);
      expect(plan.name.th).toBeTruthy();
      expect(plan.name.th.length).toBeGreaterThan(0);
      expect(plan.name.sv).toBeTruthy();
      expect(plan.name.sv.length).toBeGreaterThan(0);
    }
  });

  it('plan IDs are unique across the catalogue', () => {
    const allIds = [
      ...CORPORATE_SEED.map((p) => p.id),
      ...PARTNERSHIP_SEED.map((p) => p.id),
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it('corporate sortOrder is strictly increasing', () => {
    const orders = CORPORATE_SEED.map((p) => p.sortOrder);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]!);
    }
  });

  it('partnership sortOrder is strictly increasing', () => {
    const orders = PARTNERSHIP_SEED.map((p) => p.sortOrder);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]!);
    }
  });

  it('every corporate plan declares a benefit matrix with no partnership block', () => {
    for (const plan of CORPORATE_SEED) {
      expect(plan.matrix).toBeDefined();
      expect(plan.matrix.partnership).toBeNull();
    }
  });

  it('every partnership plan declares a benefit matrix with a populated partnership block', () => {
    for (const plan of PARTNERSHIP_SEED) {
      expect(plan.matrix).toBeDefined();
      expect(plan.matrix.partnership).not.toBeNull();
    }
  });
});
