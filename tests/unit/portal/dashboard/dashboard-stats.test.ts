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

  it.each(['lapsed', 'cancelled'] as const)(
    'returns lapsed (destructive) for a terminal %s cycle expired in the past',
    (status) => {
      // 057 R2 finding A — only `lapsed`/`cancelled` terminal statuses mean
      // coverage has ENDED. isOverdue() returns false for terminal statuses,
      // and the `due` branch excludes terminal too, so without an explicit
      // branch these fell through to `active` and misinformed.
      const stat = deriveMembershipStat(
        cycle({ status, expiresAt: '2026-05-27T00:00:00.000Z' }),
        NOW,
      );
      expect(stat.kind).toBe('lapsed');
      expect(stat.variant).toBe('destructive');
      expect(stat.status).toBe(status);
    },
  );

  it('returns active (neutral) for a `completed` cycle even after its period ends', () => {
    // 057 R2 finding A (CRITICAL) — `completed` means the member PAID/renewed
    // (closedReason 'paid'/'completed_offline'/'admin_reactivated'). The
    // renewals module creates no successor cycle (deferred R3), so a paid
    // member's `completed` cycle stays the most-recent and, once its period
    // ends, MUST NOT be shown "Membership lapsed — Renew" (which prompts a
    // duplicate payment). A completed cycle is in good standing regardless of
    // whether its period boundary has passed.
    const stat = deriveMembershipStat(
      cycle({ status: 'completed', expiresAt: '2026-05-27T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('active');
    expect(stat.variant).toBe('neutral');
    expect(stat.status).toBe('completed');
  });

  it.each(['lapsed', 'cancelled'] as const)(
    'returns lapsed for a terminal %s cycle even when expiresAt is unparseable (finding F)',
    (status) => {
      // 057 R2 finding F — a terminal lapsed/cancelled cycle with a malformed
      // expiresAt (Date.parse → NaN) must still resolve to `lapsed`. Previously
      // `NaN < now` is false, so it fell through to `active` and misinformed.
      const stat = deriveMembershipStat(
        cycle({ status, expiresAt: 'not-a-date' }),
        NOW,
      );
      expect(stat.kind).toBe('lapsed');
      expect(stat.variant).toBe('destructive');
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
    // 057 R2 finding B — the red headline figure must be the past-due subset
    // (`overdueSatang`), NOT the full owed total. They must differ whenever a
    // not-yet-due invoice is present, so the section can show only THB 53.50
    // in red rather than the THB 1,123.50 total (over-alarming).
    expect(stat.overdueSatang).toBeLessThan(stat.totalSatang);
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

  // Defer 1 — error sentinel (mirrors membership / outstanding error branches)
  it('returns error (warning) when the benefit read failed — sentinel distinct from empty', () => {
    // A computeBenefitUsage result-not-ok must NOT render "No benefits yet"
    // (which implies the plan has no benefits), nor silently show on-track.
    // It must produce kind:'error' / variant:'warning' so the section renders
    // a transient-failure placeholder ("Benefits unavailable").
    const stat = deriveBenefitsStat('error');
    expect(stat.kind).toBe('error');
    expect(stat.variant).toBe('warning');
    expect(stat.underUseCount).toBe(0);
  });
});

describe('deriveMembershipStat — lapsed instant-level boundary (Defer 2)', () => {
  it('flips to lapsed the instant expiry passes — same millisecond semantics as isOverdue', () => {
    // Expiry at 08:00 BKK (01:00 UTC); now is 14:00 BKK (07:00 UTC) same day.
    // Math.ceil day-granularity gives days=0 (stays active); instant comparison
    // gives lapsed. This is the Defer 2 boundary case.
    const expiresAt = '2026-06-06T01:00:00.000Z'; // 08:00 Asia/Bangkok
    const now = new Date('2026-06-06T07:00:00.000Z'); // 14:00 Asia/Bangkok
    const stat = deriveMembershipStat(cycle({ status: 'lapsed', expiresAt, periodTo: expiresAt }), now);
    expect(stat.kind).toBe('lapsed');
    expect(stat.variant).toBe('destructive');
  });

  it('stays active for a terminal cycle whose expiry is in the future (instant)', () => {
    // now is 06:00 UTC; expiry is 08:00 UTC same day → not yet past
    const expiresAt = '2026-06-06T08:00:00.000Z';
    const now = new Date('2026-06-06T06:00:00.000Z');
    const stat = deriveMembershipStat(cycle({ status: 'completed', expiresAt, periodTo: expiresAt }), now);
    expect(stat.kind).toBe('active');
  });
});
