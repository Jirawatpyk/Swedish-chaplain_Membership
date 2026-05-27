/**
 * F9 US4 (T060) — `BenefitUsage` domain VO unit + property tests.
 *
 * Pins FR-021: aggregate consumed % = mean of quantifiable (used÷entitlement)
 * ratios; under-use warning fires iff `elapsedYearPct − aggregate ≥ 25`; no
 * quantifiable benefit → null aggregate + never warns. Plus `yearElapsedPct`
 * boundary clamping (FR-023 membership-year math).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  UNDER_USE_WARNING_THRESHOLD_PCT,
  assessUnderUse,
  buildBenefitUsage,
  yearElapsedPct,
  type QuantifiableBenefit,
} from '@/modules/insights/domain/benefit-usage';

describe('assessUnderUse (FR-021)', () => {
  it('empty ratio set → null aggregate, no warning', () => {
    const r = assessUnderUse([], 99);
    expect(r.aggregateConsumedPct).toBeNull();
    expect(r.gapPct).toBeNull();
    expect(r.underUseWarning).toBe(false);
  });

  it('the spec worked example: 62% elapsed, 33% used → 29pt gap → warns', () => {
    // Two benefits averaging a 0.33 ratio (e.g. 2/6 + ~0.0 → mean ≈ 0.33).
    const r = assessUnderUse([0.33], 62);
    expect(r.aggregateConsumedPct).toBeCloseTo(33, 5);
    expect(r.gapPct).toBeCloseTo(29, 5);
    expect(r.underUseWarning).toBe(true);
  });

  it('exactly 25pt gap → warns (inclusive threshold)', () => {
    expect(assessUnderUse([0.25], 50).underUseWarning).toBe(true);
  });

  it('24.9pt gap → does not warn', () => {
    expect(assessUnderUse([0.251], 50).underUseWarning).toBe(false);
  });

  it('property: warning ⇔ (ratios non-empty ∧ elapsed − mean·100 ≥ 25)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 3, noNaN: true }), { maxLength: 6 }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (ratios, elapsed) => {
          const r = assessUnderUse(ratios, elapsed);
          if (ratios.length === 0) {
            expect(r.aggregateConsumedPct).toBeNull();
            expect(r.underUseWarning).toBe(false);
            return;
          }
          const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
          const expectedGap = elapsed - mean * 100;
          expect(r.aggregateConsumedPct).toBeCloseTo(mean * 100, 6);
          expect(r.gapPct).toBeCloseTo(expectedGap, 6);
          expect(r.underUseWarning).toBe(
            expectedGap >= UNDER_USE_WARNING_THRESHOLD_PCT,
          );
        },
      ),
    );
  });
});

describe('yearElapsedPct (FR-023 boundary clamping)', () => {
  it('clamps to 0 at/before year start and 100 at/after year end', () => {
    expect(yearElapsedPct(100, 100, 200)).toBe(0);
    expect(yearElapsedPct(50, 100, 200)).toBe(0);
    expect(yearElapsedPct(200, 100, 200)).toBe(100);
    expect(yearElapsedPct(250, 100, 200)).toBe(100);
  });

  it('mid-year is linear', () => {
    expect(yearElapsedPct(150, 100, 200)).toBeCloseTo(50, 6);
  });

  it('degenerate (end ≤ start) → 0', () => {
    expect(yearElapsedPct(150, 200, 200)).toBe(0);
  });
});

describe('buildBenefitUsage', () => {
  const eblast: QuantifiableBenefit = {
    key: 'eblast',
    used: 2,
    entitlement: 6,
    lastUsedAt: '2026-03-01T00:00:00.000Z',
  };

  it('AS-1/AS-2: 2/6 eblast at 62% elapsed → aggregate 33%, warns', () => {
    const usage = buildBenefitUsage({
      membershipYear: 2026,
      elapsedYearPct: 62,
      quantifiable: [eblast],
      active: [{ key: 'all_employee_event_discount' }],
    });
    expect(usage.aggregateConsumedPct).toBeCloseTo(33.333, 2);
    expect(usage.underUseWarning).toBe(true);
    expect(usage.active).toHaveLength(1);
  });

  it('AS-3: no quantifiable benefits (only active) → no warning, null aggregate', () => {
    const usage = buildBenefitUsage({
      membershipYear: 2026,
      elapsedYearPct: 95,
      quantifiable: [],
      active: [{ key: 'directory_listing' }],
    });
    expect(usage.aggregateConsumedPct).toBeNull();
    expect(usage.underUseWarning).toBe(false);
  });
});
