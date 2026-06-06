// tests/unit/portal/dashboard/dashboard-stats.test.ts
import { describe, expect, it } from 'vitest';
import {
  deriveMembershipStat,
  deriveOutstandingStat,
  deriveBenefitsStat,
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

  it('returns active (neutral) for a completed cycle still within its period', () => {
    // completed but expiry is in the FUTURE → coverage still running → good standing.
    const stat = deriveMembershipStat(
      cycle({ status: 'completed', expiresAt: '2026-07-06T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('active');
    expect(stat.variant).toBe('neutral');
  });

  it.each(['lapsed', 'cancelled', 'completed'] as const)(
    'returns lapsed (destructive) for a terminal %s cycle expired in the past',
    (status) => {
      // F11 — a terminal cycle whose coverage has ended MUST NOT read
      // "Active — in good standing". isOverdue() returns false for terminal
      // statuses, and the `due` branch excludes terminal too, so without an
      // explicit branch these fell through to `active` and misinformed.
      const stat = deriveMembershipStat(
        cycle({ status, expiresAt: '2026-05-27T00:00:00.000Z' }),
        NOW,
      );
      expect(stat.kind).toBe('lapsed');
      expect(stat.variant).toBe('destructive');
      expect(stat.status).toBe(status);
    },
  );

  it('returns error (warning) when the renewal read failed (not first-run)', () => {
    // F4 — a DB-throw collapsed to a different sentinel than a genuine
    // no-cycle member. `'error'` must NOT render the "Welcome aboard"
    // first-run state, which would hide an overdue signal on a transient
    // failure.
    const stat = deriveMembershipStat('error', NOW);
    expect(stat.kind).toBe('error');
    expect(stat.variant).toBe('warning');
    expect(stat.daysRemaining).toBeNull();
    expect(stat.status).toBeNull();
  });
});

describe('deriveOutstandingStat', () => {
  // Bangkok-local "today" the section threads in. All dueDates below
  // relative to this anchor.
  const TODAY_BKK = '2026-06-06';

  it('sums issued totals and counts them; classifies overdue vs not-yet-due', () => {
    const stat = deriveOutstandingStat(
      [
        { status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' }, // future → not overdue
        { status: 'issued', totalSatang: 53_50n, dueDate: '2026-05-10' }, // past → overdue
        { status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' },
      ],
      TODAY_BKK,
    );
    // ≥1 overdue → the stat is `overdue` (destructive).
    expect(stat.kind).toBe('overdue');
    expect(stat.totalSatang).toBe(1_123_50n);
    expect(stat.count).toBe(2);
    expect(stat.overdueCount).toBe(1);
    expect(stat.overdueSatang).toBe(53_50n);
    expect(stat.earliestDueDate).toBe('2026-05-10');
  });

  it('returns `due` (not destructive) when owing but nothing is overdue yet', () => {
    // F5 — every issued invoice is in the net-N window → warning, not red.
    const stat = deriveOutstandingStat(
      [
        { status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' },
        { status: 'issued', totalSatang: 53_50n, dueDate: '2026-06-30' },
      ],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('due');
    expect(stat.count).toBe(2);
    expect(stat.overdueCount).toBe(0);
    expect(stat.overdueSatang).toBe(0n);
  });

  it('treats dueDate === today as NOT overdue (full Bangkok business day to pay)', () => {
    const stat = deriveOutstandingStat(
      [{ status: 'issued', totalSatang: 100_00n, dueDate: TODAY_BKK }],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('due');
    expect(stat.overdueCount).toBe(0);
  });

  it('treats a null dueDate issued invoice as owing but not overdue', () => {
    const stat = deriveOutstandingStat(
      [{ status: 'issued', totalSatang: 100_00n, dueDate: null }],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('due');
    expect(stat.overdueCount).toBe(0);
  });

  it('returns the clear/first-run variant when nothing is owed', () => {
    const stat = deriveOutstandingStat(
      [{ status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' }],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('clear');
    expect(stat.totalSatang).toBe(0n);
    expect(stat.count).toBe(0);
    expect(stat.overdueCount).toBe(0);
  });

  it('treats an empty list as clear (first-run member)', () => {
    expect(deriveOutstandingStat([], TODAY_BKK).kind).toBe('clear');
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
