// tests/unit/portal/dashboard/dashboard-stats.test.ts
import { describe, expect, it } from 'vitest';
import {
  RENEW_DUE_THRESHOLD_DAYS,
  deriveMembershipStat,
  deriveOutstandingStat,
  deriveBenefitsStat,
  isRenewDue,
} from '@/app/(member)/portal/_lib/dashboard-stats';
import type { RenewalCycle } from '@/modules/renewals';
import type { BenefitUsage } from '@/modules/insights';

function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't',
    cycleId: 'c1',
    memberId: 'm1',
    status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z',
    periodTo: '2026-12-31T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    createdAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    closedReason: null,
    ...overrides,
  } as RenewalCycle;
}

const NOW = new Date('2026-06-06T00:00:00.000Z');

describe('deriveMembershipStat', () => {
  it('returns the empty/first-run variant when the member has no cycle', () => {
    const stat = deriveMembershipStat(null, NOW);
    expect(stat.kind).toBe('empty');
    expect(stat.variant).toBe('neutral');
    expect(stat.daysRemaining).toBeNull();
  });

  it('returns action-needed (warning) when awaiting payment within the renew threshold', () => {
    // expires 10 days out → within the 30-day threshold
    const stat = deriveMembershipStat(
      cycle({ status: 'awaiting_payment', expiresAt: '2026-06-16T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('due');
    expect(stat.variant).toBe('warning');
    expect(stat.daysRemaining).toBe(10);
  });

  it('returns overdue (destructive) when the cycle has expired and is non-terminal', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'awaiting_payment', expiresAt: '2026-05-27T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('overdue');
    expect(stat.variant).toBe('destructive');
    expect(stat.daysRemaining).toBe(-10);
  });

  it('returns active (neutral) when renewal is far off — no stale countdown', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'completed', expiresAt: '2026-12-31T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('active');
    expect(stat.variant).toBe('neutral');
  });
});

describe('isRenewDue', () => {
  it('is false when there is no cycle', () => {
    expect(isRenewDue(null, NOW)).toBe(false);
  });
  it('is true within the threshold, false outside it', () => {
    expect(isRenewDue(cycle({ expiresAt: '2026-06-16T00:00:00.000Z' }), NOW)).toBe(true);
    expect(isRenewDue(cycle({ expiresAt: '2026-09-30T00:00:00.000Z' }), NOW)).toBe(false);
  });
  it('is true when overdue (negative days still inside the renew window)', () => {
    expect(isRenewDue(cycle({ expiresAt: '2026-05-27T00:00:00.000Z' }), NOW)).toBe(true);
  });
  it('is false for a terminal completed cycle far from expiry', () => {
    expect(
      isRenewDue(cycle({ status: 'completed', expiresAt: '2026-12-31T00:00:00.000Z' }), NOW),
    ).toBe(false);
  });
  it('exposes the threshold constant', () => {
    expect(RENEW_DUE_THRESHOLD_DAYS).toBe(30);
  });
});

describe('deriveOutstandingStat', () => {
  it('sums issued/overdue totals and counts them', () => {
    const stat = deriveOutstandingStat([
      { status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' },
      { status: 'issued', totalSatang: 53_50n, dueDate: '2026-06-10' },
      { status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' },
    ]);
    expect(stat.kind).toBe('owing');
    expect(stat.totalSatang).toBe(1_123_50n);
    expect(stat.count).toBe(2);
    expect(stat.earliestDueDate).toBe('2026-06-10');
  });

  it('returns the clear/first-run variant when nothing is owed', () => {
    const stat = deriveOutstandingStat([
      { status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' },
    ]);
    expect(stat.kind).toBe('clear');
    expect(stat.totalSatang).toBe(0n);
    expect(stat.count).toBe(0);
  });

  it('treats an empty list as clear (first-run member)', () => {
    expect(deriveOutstandingStat([]).kind).toBe('clear');
  });
});

describe('deriveBenefitsStat', () => {
  function usage(overrides: Partial<BenefitUsage>): BenefitUsage {
    return {
      membershipYear: 2026,
      elapsedYearPct: 50,
      quantifiable: [],
      active: [],
      aggregateConsumedPct: null,
      gapPct: null,
      underUseWarning: false,
      ...overrides,
    };
  }

  it('returns empty/first-run when the member has no benefits at all', () => {
    expect(deriveBenefitsStat(usage({})).kind).toBe('empty');
  });

  it('counts per-benefit under-use (each benefit ratio lagging elapsed-year by ≥25pts)', () => {
    // elapsed 80%; eblast 0/5 (0%) is under-used, cultural 5/5 (100%) is on track
    const stat = deriveBenefitsStat(
      usage({
        elapsedYearPct: 80,
        quantifiable: [
          { key: 'eblast', used: 0, entitlement: 5, lastUsedAt: null },
          { key: 'cultural_tickets', used: 5, entitlement: 5, lastUsedAt: '2026-03-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(stat.kind).toBe('under-use');
    expect(stat.variant).toBe('warning');
    expect(stat.underUseCount).toBe(1);
  });

  it('returns on-track when every benefit keeps pace with the year', () => {
    const stat = deriveBenefitsStat(
      usage({
        elapsedYearPct: 50,
        quantifiable: [{ key: 'eblast', used: 3, entitlement: 5, lastUsedAt: null }],
      }),
    );
    expect(stat.kind).toBe('on-track');
    expect(stat.variant).toBe('neutral');
    expect(stat.underUseCount).toBe(0);
  });

  it('is on-track (never under-use) for an active-only plan with no quantifiable benefits', () => {
    const stat = deriveBenefitsStat(usage({ active: [{ key: 'logo_listing' }] }));
    expect(stat.kind).toBe('on-track');
  });
});
