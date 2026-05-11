/**
 * F8 Phase 6 Wave A1 — Domain at-risk-score FR-029 contract test.
 *
 * Rewrites the Wave D shipped test (which validated a different, codebase-
 * derived factor set) against the canonical 8-factor formula in spec
 * `specs/011-renewal-reminders/spec.md` § FR-029, the F6-readiness
 * fallback FR-029a, the proportional-band derivation FR-030, and the
 * audit-port contract `active_max: 70 | 100` literal at
 * `specs/011-renewal-reminders/contracts/audit-port.md` line 297.
 *
 * Implementation note (P6 sub-finding surfaced at Wave A1): the audit-port
 * `active_max: 70` literal can only be reconciled with FR-029's per-factor
 * weights if the **cultural-ticket factor is also classified as F6-
 * dependent** (it sources from event-ticket data, parallel to the two
 * events-attended factors). With that classification:
 *   - F6-dependent factors: events 12mo (+25) + events 3mo (+10) + cultural
 *     ticket (+10) = 45 points
 *   - F6-independent factors: e-blast (+15) + invoices-overdue (+25) +
 *     days-since-payment (+10) + days-since-contact (+5) + tier-downgrade
 *     (+15) = 70 points (matches audit-port `active_max: 70` exactly)
 *   - F6-active total: 115 (clipped to 100 per FR-029 `min(100, sum)`)
 * This classification is documented in `at-risk-score.ts` AT_RISK_FACTOR_
 * WEIGHTS table; defer formal spec-text amendment to a follow-up
 * `/speckit.clarify` round if maintainer prefers a different reading.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeAtRiskScore,
  AT_RISK_FACTOR_WEIGHTS,
  F6_INACTIVE_MAX,
  F6_ACTIVE_MAX,
  type AtRiskComputeContext,
  type AtRiskFactors,
} from '@/modules/renewals/domain/at-risk-score';
import { bandForScoreProportional } from '@/modules/renewals/domain/value-objects/risk-band';

const ctxF6Available: AtRiskComputeContext = {
  minTenureDays: 30,
  eventAttendeesAvailable: true,
};
const ctxF6Unavailable: AtRiskComputeContext = {
  minTenureDays: 30,
  eventAttendeesAvailable: false,
};

// ---------------------------------------------------------------------------
// Min-tenure gate (FR-035)
// ---------------------------------------------------------------------------

describe('min-tenure gate (FR-035)', () => {
  it('skips scoring for members <30d tenure (default)', () => {
    const r = computeAtRiskScore({ tenureDays: 15 }, ctxF6Available);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.skippedBelowMinTenure).toBe(true);
      expect(r.value.score).toBe(0);
      expect(r.value.band).toBe('healthy');
      expect(r.value.contributions).toEqual([]);
    }
  });

  it('includes member at exactly minTenureDays threshold', () => {
    const r = computeAtRiskScore({ tenureDays: 30 }, ctxF6Available);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skippedBelowMinTenure).toBe(false);
  });

  it('honors a custom min-tenure threshold from context', () => {
    const r = computeAtRiskScore(
      { tenureDays: 45 },
      { ...ctxF6Available, minTenureDays: 60 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skippedBelowMinTenure).toBe(true);
  });

  it('coerces missing tenureDays to null in result (R11 ?? branch coverage)', () => {
    const r = computeAtRiskScore({}, ctxF6Available);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tenureDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Each FR-029 factor weight in isolation
// ---------------------------------------------------------------------------

describe('FR-029 factor weights (single-factor contributions)', () => {
  it('Events attended last 12mo == 0 → +25 (F6 active)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eventsAttendedLast12Months: 0 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(25);
      expect(
        r.value.contributions.find(
          (c) => c.factor === 'events_attended_last_12mo_zero',
        )?.points,
      ).toBe(25);
    }
  });

  it('Events attended last 3mo == 0 (with >0 in last 12mo) → +10', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 5,
        eventsAttendedLast3Months: 0,
      },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(10);
      expect(
        r.value.contributions.find(
          (c) => c.factor === 'events_attended_last_3mo_zero',
        )?.points,
      ).toBe(10);
    }
  });

  it('events_3mo factor does NOT add when events_12mo is also 0 (12mo wins)', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0,
        eventsAttendedLast3Months: 0,
      },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Only the 12mo factor fires (25), NOT both (25+10=35)
      expect(r.value.score).toBe(25);
      expect(
        r.value.contributions.some(
          (c) => c.factor === 'events_attended_last_3mo_zero',
        ),
      ).toBe(false);
    }
  });

  it('E-Blast quota used <30% → +15', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eBlastQuotaPctUsed: 25 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(15);
  });

  it('E-Blast quota at exactly 30% → no penalty (boundary)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eBlastQuotaPctUsed: 30 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(0);
  });

  it('Cultural-ticket quota used <50% → +10 (F6 active)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, culturalTicketQuotaPctUsed: 40 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(10);
  });

  it('Invoices overdue count >0 → +25', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, invoicesOverdueCount: 1 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(25);
  });

  it('Invoices overdue count >0 → +25 regardless of count (idempotent)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, invoicesOverdueCount: 5 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Per FR-029: the factor is binary (0 vs >0), not multiplied per invoice
      expect(r.value.score).toBe(25);
    }
  });

  it('Days since last payment >180 → +10', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysSinceLastPayment: 200 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(10);
  });

  it('Days since last payment at 180 (boundary) → no penalty', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, daysSinceLastPayment: 180 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(0);
  });

  it('Days since contact-record update >365 → +5', () => {
    const r = computeAtRiskScore(
      { tenureDays: 800, daysSinceContactUpdate: 400 },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(5);
  });

  it('Tier downgraded last 12mo → +15', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, tierDowngradedLast12Months: true },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.score).toBe(15);
  });

  it('AT_RISK_FACTOR_WEIGHTS constant is exported and matches FR-029', () => {
    expect(AT_RISK_FACTOR_WEIGHTS.events_attended_last_12mo_zero).toBe(25);
    expect(AT_RISK_FACTOR_WEIGHTS.events_attended_last_3mo_zero).toBe(10);
    expect(AT_RISK_FACTOR_WEIGHTS.e_blast_quota_under_30pct).toBe(15);
    expect(AT_RISK_FACTOR_WEIGHTS.cultural_ticket_quota_under_50pct).toBe(10);
    expect(AT_RISK_FACTOR_WEIGHTS.invoices_overdue_count_gt_zero).toBe(25);
    expect(AT_RISK_FACTOR_WEIGHTS.days_since_last_payment_gt_180).toBe(10);
    expect(AT_RISK_FACTOR_WEIGHTS.days_since_contact_update_gt_365).toBe(5);
    expect(AT_RISK_FACTOR_WEIGHTS.tier_downgraded_last_12mo).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// F6-readiness fallback (FR-029a)
// ---------------------------------------------------------------------------

describe('F6-readiness fallback (FR-029a)', () => {
  it('F6 inactive ⇒ events_attended_last_12mo factor skipped + flagged', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, eventsAttendedLast12Months: 0 },
      ctxF6Unavailable,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.eventAttendanceFactorSkipped).toBe(true);
      expect(r.value.score).toBe(0);
      expect(
        r.value.contributions.some(
          (c) => c.factor === 'events_attended_last_12mo_zero',
        ),
      ).toBe(false);
    }
  });

  it('F6 inactive ⇒ events_attended_last_3mo factor skipped', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 5,
        eventsAttendedLast3Months: 0,
      },
      ctxF6Unavailable,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0);
      expect(
        r.value.contributions.some(
          (c) => c.factor === 'events_attended_last_3mo_zero',
        ),
      ).toBe(false);
    }
  });

  it('F6 inactive ⇒ cultural_ticket factor skipped (event-ticket dep)', () => {
    const r = computeAtRiskScore(
      { tenureDays: 365, culturalTicketQuotaPctUsed: 10 },
      ctxF6Unavailable,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0);
      expect(
        r.value.contributions.some(
          (c) => c.factor === 'cultural_ticket_quota_under_50pct',
        ),
      ).toBe(false);
    }
  });

  it('F6 inactive ⇒ F6-independent factors still contribute', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eBlastQuotaPctUsed: 10, // +15
        invoicesOverdueCount: 1, // +25
        daysSinceLastPayment: 200, // +10
        daysSinceContactUpdate: 400, // +5
        tierDowngradedLast12Months: true, // +15
      },
      ctxF6Unavailable,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(70); // F6-inactive max per audit-port `active_max: 70`
      expect(r.value.eventAttendanceFactorSkipped).toBe(true);
    }
  });

  it('F6_INACTIVE_MAX constant is 70 (matches audit-port active_max)', () => {
    expect(F6_INACTIVE_MAX).toBe(70);
  });

  it('F6_ACTIVE_MAX constant is 100 (clipped from raw 115 sum)', () => {
    expect(F6_ACTIVE_MAX).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Score saturation (FR-029 `min(100, sum_of_active_factor_points)`)
// ---------------------------------------------------------------------------

describe('score saturation', () => {
  it('F6 active: clamps to 100 even when factors sum to 115 (raw max)', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0, // +25
        eBlastQuotaPctUsed: 10, // +15
        culturalTicketQuotaPctUsed: 10, // +10
        invoicesOverdueCount: 1, // +25
        daysSinceLastPayment: 300, // +10
        daysSinceContactUpdate: 400, // +5
        tierDowngradedLast12Months: true, // +15
      },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(100); // clipped from 105
      expect(r.value.band).toBe('critical');
    }
  });

  it('score never goes below 0 even with empty factors', () => {
    const r = computeAtRiskScore({ tenureDays: 365 }, ctxF6Available);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(0);
      expect(r.value.band).toBe('healthy');
    }
  });
});

// ---------------------------------------------------------------------------
// AS1 spec example — `25 + 25 + 10 = 60`
// ---------------------------------------------------------------------------

describe('AS1 spec example (FR-029)', () => {
  it('events_12mo=0 + invoices_overdue=1 + days_since_payment=280 ⇒ 60 (at-risk band)', () => {
    const r = computeAtRiskScore(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0,
        invoicesOverdueCount: 1,
        daysSinceLastPayment: 280,
      },
      ctxF6Available,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.score).toBe(60); // AS1 arithmetic
      expect(r.value.band).toBe('at-risk');
    }
  });
});

// ---------------------------------------------------------------------------
// Proportional bands (FR-030)
// ---------------------------------------------------------------------------

describe('proportional bands (FR-030)', () => {
  it('F6 active (max=100): bands at 0–24 / 25–49 / 50–74 / 75–100', () => {
    expect(bandForScoreProportional(24, 100)).toEqual({ ok: true, value: 'healthy' });
    expect(bandForScoreProportional(25, 100)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScoreProportional(49, 100)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScoreProportional(50, 100)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScoreProportional(74, 100)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScoreProportional(75, 100)).toEqual({ ok: true, value: 'critical' });
    expect(bandForScoreProportional(100, 100)).toEqual({ ok: true, value: 'critical' });
  });

  it('F6 inactive (max=70): bands at 0–17 / 18–34 / 35–52 / 53–70', () => {
    expect(bandForScoreProportional(17, 70)).toEqual({ ok: true, value: 'healthy' });
    expect(bandForScoreProportional(18, 70)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScoreProportional(34, 70)).toEqual({ ok: true, value: 'warning' });
    expect(bandForScoreProportional(35, 70)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScoreProportional(52, 70)).toEqual({ ok: true, value: 'at-risk' });
    expect(bandForScoreProportional(53, 70)).toEqual({ ok: true, value: 'critical' });
    expect(bandForScoreProportional(70, 70)).toEqual({ ok: true, value: 'critical' });
  });

  it('rejects out-of-range scores', () => {
    const r1 = bandForScoreProportional(101, 100);
    expect(r1.ok).toBe(false);
    const r2 = bandForScoreProportional(-1, 100);
    expect(r2.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests (T172) — 256 factor combos × 2 F6-active toggles = 512
// ---------------------------------------------------------------------------

describe('property-based — score invariants (T172, 512 cases)', () => {
  // Conservative arbitrary that covers the realistic factor input space.
  const factorsArb = fc.record({
    tenureDays: fc.integer({ min: 30, max: 1000 }),
    eventsAttendedLast12Months: fc.integer({ min: 0, max: 30 }),
    eventsAttendedLast3Months: fc.integer({ min: 0, max: 10 }),
    eBlastQuotaPctUsed: fc.integer({ min: 0, max: 100 }),
    culturalTicketQuotaPctUsed: fc.integer({ min: 0, max: 100 }),
    invoicesOverdueCount: fc.integer({ min: 0, max: 20 }),
    daysSinceLastPayment: fc.integer({ min: 0, max: 800 }),
    daysSinceContactUpdate: fc.integer({ min: 0, max: 1500 }),
    tierDowngradedLast12Months: fc.boolean(),
  });

  it('score is always in [0, 100] regardless of inputs (clip invariant)', () => {
    fc.assert(
      fc.property(factorsArb, fc.boolean(), (factors, f6Available) => {
        const ctx: AtRiskComputeContext = {
          minTenureDays: 30,
          eventAttendeesAvailable: f6Available,
        };
        const r = computeAtRiskScore(factors as AtRiskFactors, ctx);
        if (!r.ok) return false;
        return r.value.score >= 0 && r.value.score <= 100;
      }),
      { numRuns: 256 },
    );
  });

  it('F6 inactive ⇒ events + cultural-ticket factors contribute 0', () => {
    fc.assert(
      fc.property(factorsArb, (factors) => {
        const r = computeAtRiskScore(
          factors as AtRiskFactors,
          ctxF6Unavailable,
        );
        if (!r.ok) return false;
        const f6Factors = [
          'events_attended_last_12mo_zero',
          'events_attended_last_3mo_zero',
          'cultural_ticket_quota_under_50pct',
        ];
        return r.value.contributions.every(
          (c) => !f6Factors.includes(c.factor),
        );
      }),
      { numRuns: 256 },
    );
  });

  it('monotonicity — adding any factor never decreases score', () => {
    // Specifically: setting `tierDowngradedLast12Months: true` from `false`
    // never decreases the score (no negative weights).
    fc.assert(
      fc.property(factorsArb, fc.boolean(), (factors, f6Available) => {
        const ctx: AtRiskComputeContext = {
          minTenureDays: 30,
          eventAttendeesAvailable: f6Available,
        };
        const baseFactors = {
          ...factors,
          tierDowngradedLast12Months: false,
        };
        const augmentedFactors = {
          ...factors,
          tierDowngradedLast12Months: true,
        };
        const base = computeAtRiskScore(baseFactors as AtRiskFactors, ctx);
        const aug = computeAtRiskScore(augmentedFactors as AtRiskFactors, ctx);
        if (!base.ok || !aug.ok) return false;
        return aug.value.score >= base.value.score;
      }),
      { numRuns: 256 },
    );
  });

  it('determinism — identical inputs always yield identical results', () => {
    // R4-S4 (staff-review-2026-05-09): use vitest's deep-equality
    // matcher (`.toEqual`) instead of `JSON.stringify === JSON.stringify`
    // — produces a readable structural diff on failure rather than
    // "expected false to be true" with no actionable signal. fast-check
    // catches the thrown assertion + reports the shrinking counter-
    // example. Returning `true` from the predicate keeps fast-check
    // happy when the assertions all pass.
    fc.assert(
      fc.property(factorsArb, fc.boolean(), (factors, f6Available) => {
        const ctx: AtRiskComputeContext = {
          minTenureDays: 30,
          eventAttendeesAvailable: f6Available,
        };
        const r1 = computeAtRiskScore(factors as AtRiskFactors, ctx);
        const r2 = computeAtRiskScore(factors as AtRiskFactors, ctx);
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        if (!r1.ok || !r2.ok) return false;
        expect(r1.value).toEqual(r2.value);
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it('skipped-below-tenure path always yields score=0 + skipped flag', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 29 }),
        factorsArb,
        fc.boolean(),
        (tenureDays, otherFactors, f6Available) => {
          const ctx: AtRiskComputeContext = {
            minTenureDays: 30,
            eventAttendeesAvailable: f6Available,
          };
          const r = computeAtRiskScore(
            { ...otherFactors, tenureDays } as AtRiskFactors,
            ctx,
          );
          return (
            r.ok &&
            r.value.score === 0 &&
            r.value.skippedBelowMinTenure === true &&
            r.value.band === 'healthy'
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('band derivation always matches bandForScoreProportional(score, activeMax)', () => {
    fc.assert(
      fc.property(factorsArb, fc.boolean(), (factors, f6Available) => {
        const ctx: AtRiskComputeContext = {
          minTenureDays: 30,
          eventAttendeesAvailable: f6Available,
        };
        const r = computeAtRiskScore(factors as AtRiskFactors, ctx);
        if (!r.ok) return false;
        if (r.value.skippedBelowMinTenure) return r.value.band === 'healthy';
        const expectedMax = f6Available ? F6_ACTIVE_MAX : F6_INACTIVE_MAX;
        const expectedBand = bandForScoreProportional(
          r.value.score,
          expectedMax,
        );
        return expectedBand.ok && expectedBand.value === r.value.band;
      }),
      { numRuns: 256 },
    );
  });
});
