/**
 * F4 Domain — calculate-pro-rate-factor policy unit tests.
 *
 * Per `src/modules/invoicing/domain/policies/calculate-pro-rate-factor.ts`
 * docstring, three policies + the fy-start/fy-end edge cases from
 * research.md § 7 must be covered.
 *
 * Authored 2026-05-17 (Phase B of F4 Domain coverage push — plan
 * `jolly-shimmying-sundae.md`).
 */
import { describe, it, expect } from 'vitest';
import {
  calculateProRateFactor,
  type ProRateInputs,
} from '@/modules/invoicing/domain/policies/calculate-pro-rate-factor';

// Use a calendar fiscal year for arithmetic clarity. The policy is
// pure over the input dates — no clock access, no TZ math — so test
// fixtures can use any year. 2026 = 365 days (non-leap); 2024 = 366.
const FY_START_2026 = '2026-01-01';
const FY_END_2026 = '2026-12-31';

describe("calculateProRateFactor — policy === 'none'", () => {
  it("always returns '1.0000' regardless of issue date", () => {
    const inputs: ProRateInputs = {
      policy: 'none',
      issueDate: '2026-06-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('1.0000');
  });

  it("returns '1.0000' even when issueDate is past the FY end", () => {
    // 'none' policy bypasses all date math; the function shouldn't
    // care about chronology.
    const inputs: ProRateInputs = {
      policy: 'none',
      issueDate: '2027-06-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('1.0000');
  });
});

describe("calculateProRateFactor — policy === 'monthly'", () => {
  it('issue on FY start day → factor = 1.0000 (full 12 months ahead)', () => {
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: FY_START_2026,
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('1.0000');
  });

  it('issue mid-fiscal-year → fractional factor by month bucket', () => {
    // Issue 2026-07-15 → July is month index 6 (0-indexed); months
    // remaining inclusive = Jul..Dec = 6 → 6/12 = 0.5000.
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2026-07-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.5000');
  });

  it('issue in last month of FY → 1/12 = 0.0833', () => {
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2026-12-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.0833');
  });

  it('issue on FY-end day in last month → still 1/12 (month bucket math)', () => {
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2026-12-31',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.0833');
  });

  it('issue past FY end → clamped to 0.0000 (no negative factors)', () => {
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2027-03-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.0000');
  });

  it('handles non-calendar FY (April-start, March-end)', () => {
    // Thai government FY: 2026-04-01 to 2027-03-31.
    // Issue 2026-10-01 → Oct..Mar = 6 months remaining / 12 → 0.5000.
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2026-10-01',
      fyStartDate: '2026-04-01',
      fyEndDate: '2027-03-31',
    };
    expect(calculateProRateFactor(inputs)).toBe('0.5000');
  });
});

describe("calculateProRateFactor — policy === 'daily'", () => {
  it('issue on FY start day → factor = 1.0000', () => {
    const inputs: ProRateInputs = {
      policy: 'daily',
      issueDate: FY_START_2026,
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('1.0000');
  });

  it('issue on FY end day → factor = minimum non-zero (1/365)', () => {
    // 1 day remaining (the FY-end day itself, inclusive) / 365 days
    // total = 0.0027 (rounded to 4dp).
    const inputs: ProRateInputs = {
      policy: 'daily',
      issueDate: FY_END_2026,
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.0027');
  });

  it('issue mid-year (~6 months in) → approximately 0.5', () => {
    // July 1 → 184 days remaining (incl) / 365 = 0.5041
    const inputs: ProRateInputs = {
      policy: 'daily',
      issueDate: '2026-07-01',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.5041');
  });

  it('issue past FY end → clamped to 0.0000', () => {
    const inputs: ProRateInputs = {
      policy: 'daily',
      issueDate: '2027-01-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    expect(calculateProRateFactor(inputs)).toBe('0.0000');
  });

  it('handles leap-year FY (366 days)', () => {
    // 2024 is leap. Issue on FY start → 1.0000; on FY end → 1/366.
    const FY_START_2024 = '2024-01-01';
    const FY_END_2024 = '2024-12-31';
    expect(
      calculateProRateFactor({
        policy: 'daily',
        issueDate: FY_START_2024,
        fyStartDate: FY_START_2024,
        fyEndDate: FY_END_2024,
      }),
    ).toBe('1.0000');
    expect(
      calculateProRateFactor({
        policy: 'daily',
        issueDate: FY_END_2024,
        fyStartDate: FY_START_2024,
        fyEndDate: FY_END_2024,
      }),
    ).toBe('0.0027'); // 1/366 = 0.00273 → 0.0027
  });
});

describe('calculateProRateFactor — output shape (4-decimal contract)', () => {
  it('always returns a 4-decimal string', () => {
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2026-06-15',
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    const result = calculateProRateFactor(inputs);
    expect(result).toMatch(/^\d\.\d{4}$/);
  });

  it("clamps to '1.0000' if math overshoots upper bound (defensive)", () => {
    // Construct a degenerate case: issue date earlier than fy start
    // (caller bug). The fourDp clamp keeps the output ≤ 1.
    // remainingMonths = fyEndM - issueM + 1 = 11 - 5 + 1 = 7 with
    // totalMonths = 12 — but we set issue BEFORE fy start, so math
    // produces values that still need the clamp to be safe.
    // We just assert the clamp never lets output exceed 1.
    const inputs: ProRateInputs = {
      policy: 'monthly',
      issueDate: '2025-06-15', // year EARLIER than fy
      fyStartDate: FY_START_2026,
      fyEndDate: FY_END_2026,
    };
    const result = calculateProRateFactor(inputs);
    const numeric = parseFloat(result);
    expect(numeric).toBeLessThanOrEqual(1);
    expect(numeric).toBeGreaterThanOrEqual(0);
  });
});
