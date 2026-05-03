/**
 * T038 spec — AtRiskScore 8-factor formula + F6-readiness fallback.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeAtRiskScore,
  type AtRiskComputeContext,
  type AtRiskFactors,
} from '@/modules/renewals/domain/at-risk-score';

const ctxF6Available: AtRiskComputeContext = {
  minTenureDays: 30,
  eventAttendeesAvailable: true,
};
const ctxF6Unavailable: AtRiskComputeContext = {
  minTenureDays: 30,
  eventAttendeesAvailable: false,
};

describe('min-tenure gate (FR-029)', () => {
  it('skips scoring for members <30d tenure (default)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 15 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.skippedBelowMinTenure).toBe(true);
      expect(r.value.score).toBe(0);
      expect(r.value.band).toBe('healthy');
      expect(r.value.contributions).toEqual([]);
    }
  });

  it('includes member at exactly minTenureDays threshold', () => {
    const r = computeAtRiskScore(
      { tenureDays: 30 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skippedBelowMinTenure).toBe(false);
  });
});

describe('inactivity factor', () => {
  it('≥90d → 25 points (at-risk band threshold)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysSinceLastActivity: 100 },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.score).toBe(25);
      expect(r.value.band).toBe('warning');
    }
  });
  it('30-89d → 10 points', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysSinceLastActivity: 30 },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.score).toBe(10);
  });
  it('<30d → 0 points', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysSinceLastActivity: 15 },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.contributions.length).toBe(0);
  });
});

describe('payment failures factor', () => {
  it('each failure adds 10 points', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, paymentFailureCount: 3 },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.score).toBe(30);
  });
});

describe('email-unverified factor', () => {
  it('emailUnverifiedOver7Days adds 15 points', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, emailUnverifiedOver7Days: true },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.score).toBe(15);
  });
});

describe('past-grace factor', () => {
  it('each day past grace adds 5 points', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysPastGrace: 4 },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.score).toBe(20);
  });
});

describe('email engagement factor', () => {
  it('3+ ignores + 0 opens → email_ignore_streak (15 points)', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        recentEmailIgnoreCount: 3,
        recentEmailOpenCount: 0,
      },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.contributions.some((c) => c.factor === 'email_ignore_streak')).toBe(true);
      expect(r.value.score).toBe(15);
    }
  });
  it('1-2 ignores + 0 opens → no_recent_opens (5 points)', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        recentEmailIgnoreCount: 2,
        recentEmailOpenCount: 0,
      },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.contributions.some((c) => c.factor === 'no_recent_opens')).toBe(true);
      expect(r.value.score).toBe(5);
    }
  });
  it('any opens >0 → no engagement penalty', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        recentEmailIgnoreCount: 5,
        recentEmailOpenCount: 1,
      },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.contributions.some((c) => c.factor.startsWith('email'))).toBe(false);
    }
  });
});

describe('F6 readiness fallback (FR-029a)', () => {
  it('eventAttendeesAvailable=false → factor skipped + flagged', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0, // would normally trigger penalty
      },
      ctxF6Unavailable,
    );
    if (r.ok) {
      expect(r.value.eventAttendanceFactorSkipped).toBe(true);
      // No penalty added.
      expect(
        r.value.contributions.some((c) => c.factor === 'no_events_attended_12mo'),
      ).toBe(false);
    }
  });

  it('eventAttendeesAvailable=true + 0 events → 10-point penalty', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eventsAttendedLast12Months: 0 },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.eventAttendanceFactorSkipped).toBe(false);
      expect(r.value.score).toBe(10);
    }
  });

  it('eventAttendeesAvailable=true + ≥1 events → no penalty', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eventsAttendedLast12Months: 5 },
      ctxF6Available,
    );
    if (r.ok) expect(r.value.score).toBe(0);
  });
});

describe('score saturation', () => {
  it('clamps to 100 even when factors sum higher', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        daysSinceLastActivity: 100, // 25
        paymentFailureCount: 5, // 50
        emailUnverifiedOver7Days: true, // 15
        daysPastGrace: 10, // 50
        // Total raw = 140
      },
      ctxF6Available,
    );
    if (r.ok) {
      expect(r.value.score).toBe(100);
      expect(r.value.band).toBe('critical');
    }
  });
});

describe('property-based — score is always [0,100] (fast-check)', () => {
  it('arbitrary factor inputs produce a score within [0,100]', () => {
    fc.assert(
      fc.property(
        fc.record({
          tenureDays: fc.integer({ min: 30, max: 1000 }),
          daysSinceLastActivity: fc.integer({ min: 0, max: 200 }),
          recentEmailOpenCount: fc.integer({ min: 0, max: 50 }),
          recentEmailIgnoreCount: fc.integer({ min: 0, max: 50 }),
          paymentFailureCount: fc.integer({ min: 0, max: 20 }),
          daysPastGrace: fc.integer({ min: 0, max: 90 }),
          emailUnverifiedOver7Days: fc.boolean(),
          eventsAttendedLast12Months: fc.integer({ min: 0, max: 20 }),
        }),
        (factors) => {
          const r = computeAtRiskScore(factors as AtRiskFactors, ctxF6Available);
          if (!r.ok) return false; // Should never happen — type is `Result<_, never>`.
          return r.value.score >= 0 && r.value.score <= 100;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('skipped-tenure path always yields score=0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 29 }),
        fc.record({
          paymentFailureCount: fc.integer({ min: 0, max: 100 }),
          daysSinceLastActivity: fc.integer({ min: 0, max: 200 }),
        }),
        (tenureDays, otherFactors) => {
          const r = computeAtRiskScore(
            { tenureDays, ...otherFactors },
            ctxF6Available,
          );
          return r.ok && r.value.score === 0 && r.value.skippedBelowMinTenure;
        },
      ),
    );
  });

  // D1 verify-run remediation — pin determinism: identical inputs must
  // always yield identical results. computeAtRiskScore is a pure function
  // (no clock / no random), so this property holds by construction; the
  // test guards against a future refactor that accidentally breaks it
  // (e.g. introducing Date.now() somewhere in the formula).
  it('determinism — identical inputs always yield identical results', () => {
    fc.assert(
      fc.property(
        fc.record({
          tenureDays: fc.integer({ min: 30, max: 1000 }),
          daysSinceLastActivity: fc.integer({ min: 0, max: 200 }),
          recentEmailOpenCount: fc.integer({ min: 0, max: 50 }),
          recentEmailIgnoreCount: fc.integer({ min: 0, max: 50 }),
          paymentFailureCount: fc.integer({ min: 0, max: 20 }),
          daysPastGrace: fc.integer({ min: 0, max: 90 }),
          emailUnverifiedOver7Days: fc.boolean(),
          eventsAttendedLast12Months: fc.integer({ min: 0, max: 20 }),
        }),
        fc.boolean(),
        (factors, eventAttendeesAvailable) => {
          const ctx: AtRiskComputeContext = {
            minTenureDays: 30,
            eventAttendeesAvailable,
          };
          const r1 = computeAtRiskScore(factors as AtRiskFactors, ctx);
          const r2 = computeAtRiskScore(factors as AtRiskFactors, ctx);
          if (!r1.ok || !r2.ok) return false;
          return (
            r1.value.score === r2.value.score &&
            r1.value.band === r2.value.band &&
            r1.value.skippedBelowMinTenure === r2.value.skippedBelowMinTenure &&
            r1.value.eventAttendanceFactorSkipped ===
              r2.value.eventAttendanceFactorSkipped &&
            JSON.stringify(r1.value.contributions) ===
              JSON.stringify(r2.value.contributions)
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
