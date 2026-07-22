/**
 * WP3 — `classifyPlanPriceChange` domain classifier.
 *
 * Pins the price-comparison contract that both the client (portal renewal
 * grouping + downgrade gate) and the server (confirmRenewal downgrade
 * refusal) consume. Per correction C-5 the currency axis is DROPPED: the
 * classifier compares two THB-satang numbers ONLY, so the client and
 * server cannot diverge on a currency argument.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPlanPriceChange,
  requiresDowngradeAck,
} from '@/modules/renewals/domain/plan-price-change';

describe('classifyPlanPriceChange', () => {
  it('target below current → downgrade', () => {
    expect(
      classifyPlanPriceChange({
        currentMinorUnits: 5_000_000,
        targetMinorUnits: 3_000_000,
      }),
    ).toBe('downgrade');
  });

  it('target above current → upgrade', () => {
    expect(
      classifyPlanPriceChange({
        currentMinorUnits: 3_000_000,
        targetMinorUnits: 5_000_000,
      }),
    ).toBe('upgrade');
  });

  it('target equal to current → same', () => {
    expect(
      classifyPlanPriceChange({
        currentMinorUnits: 5_000_000,
        targetMinorUnits: 5_000_000,
      }),
    ).toBe('same');
  });

  it('a zero target against a non-zero current is a downgrade (NOT a falsy bug)', () => {
    expect(
      classifyPlanPriceChange({
        currentMinorUnits: 5_000_000,
        targetMinorUnits: 0,
      }),
    ).toBe('downgrade');
  });

  it('numeric-satang contract pin: classify(3_600_000 → 900_000) === downgrade', () => {
    expect(
      classifyPlanPriceChange({
        currentMinorUnits: 3_600_000,
        targetMinorUnits: 900_000,
      }),
    ).toBe('downgrade');
  });
});

describe('requiresDowngradeAck', () => {
  it('is true ONLY for a downgrade', () => {
    expect(requiresDowngradeAck('downgrade')).toBe(true);
    expect(requiresDowngradeAck('upgrade')).toBe(false);
    expect(requiresDowngradeAck('same')).toBe(false);
  });
});
