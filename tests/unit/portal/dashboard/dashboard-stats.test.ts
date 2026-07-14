// tests/unit/portal/dashboard/dashboard-stats.test.ts
import { describe, expect, it } from 'vitest';
import {
  deriveMembershipStat,
  deriveOutstandingStat,
  deriveBenefitsStat,
} from '@/app/(member)/portal/_lib/dashboard-stats';
import { isMembershipLapsed } from '@/modules/renewals';
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

  it('returns action-needed (warning) when renewal is due soon and not yet invoiced', () => {
    // 059-membership-suspension — `awaiting_payment` now ALWAYS resolves to
    // `suspended` via `deriveMembershipAccess` (an invoice has been issued;
    // benefits pause immediately per the TSCC policy change), so the `due`
    // ("renew soon") warning only applies to the pre-invoice `upcoming`/
    // `reminded` statuses now. expires 10 days out → within the 30-day
    // threshold, and the cycle is NOT yet expired → access stays `full`.
    const stat = deriveMembershipStat(
      cycle({ status: 'upcoming', expiresAt: '2026-06-16T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('due');
    expect(stat.variant).toBe('warning');
    expect(stat.daysRemaining).toBe(10);
    expect(stat.reason).toBeNull();
  });

  it('returns suspended (warning, reason unpaid) when a non-terminal cycle has expired — closes the 06:15-cron gap', () => {
    // 059-membership-suspension — a non-terminal (`upcoming`/`reminded`)
    // cycle whose period already ended is now `suspended`/`unpaid`
    // (benefits paused), NOT the old destructive `overdue` kind. The old
    // `overdue` kind is retained on the type for back-compat but is no
    // longer produced by this function — the underlying condition it used
    // to capture (non-terminal + expired) is now fully absorbed into
    // `suspended`.
    const stat = deriveMembershipStat(
      cycle({ status: 'upcoming', expiresAt: '2026-05-27T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('suspended');
    expect(stat.kind).not.toBe('overdue');
    expect(stat.variant).toBe('warning');
    expect(stat.daysRemaining).toBe(-10);
    expect(stat.reason).toBe('unpaid');
  });

  it.each(['awaiting_payment', 'reminded', 'upcoming'] as const)(
    'always resolves an unpaid-invoice %s cycle to suspended, regardless of days remaining',
    (status) => {
      // `awaiting_payment` means an invoice was issued and payment is
      // awaited — per the new TSCC policy this ALWAYS pauses benefits, even
      // when the cycle has not yet expired (a member confirming renewal
      // early via the self-service lazy transition).
      const future = deriveMembershipStat(
        cycle({ status, expiresAt: '2026-12-31T00:00:00.000Z' }),
        NOW,
      );
      if (status === 'awaiting_payment') {
        expect(future.kind).toBe('suspended');
        expect(future.reason).toBe('unpaid');
      } else {
        // upcoming/reminded with a FUTURE expiry stay full (due/active).
        expect(['due', 'active']).toContain(future.kind);
        expect(future.reason).toBeNull();
      }
    },
  );

  it('returns suspended (warning, reason unpaid) for an awaiting_payment cycle even with a far-future expiry', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'awaiting_payment', expiresAt: '2026-12-31T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('suspended');
    expect(stat.variant).toBe('warning');
    expect(stat.reason).toBe('unpaid');
  });

  it('returns suspended (warning, reason pending_review) for pending_admin_reactivation regardless of expiry', () => {
    const stat = deriveMembershipStat(
      cycle({ status: 'pending_admin_reactivation', expiresAt: '2026-01-01T00:00:00.000Z', enteredPendingAt: '2026-01-01T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('suspended');
    expect(stat.variant).toBe('warning');
    expect(stat.reason).toBe('pending_review');
  });

  it('returns active (neutral) for a cancelled cycle whose period has NOT yet ended', () => {
    // A cancelled cycle with a FUTURE expiry is not ended coverage —
    // deriveMembershipAccess resolves it to `full`, matching the pre-
    // existing behaviour (an admin-cancelled duplicate `upcoming` cycle
    // must not lock the member out).
    const stat = deriveMembershipStat(
      cycle({ status: 'cancelled', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'cancelled', expiresAt: '2026-12-31T00:00:00.000Z' }),
      NOW,
    );
    expect(stat.kind).toBe('active');
    expect(stat.reason).toBeNull();
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
      expect(stat.reason).toBe(status === 'lapsed' ? 'grace_expired' : 'cancelled');
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
      expect(stat.reason).toBe(status === 'lapsed' ? 'grace_expired' : 'cancelled');
    },
  );

  it.each(['awaiting_payment', 'reminded', 'upcoming'] as const)(
    'resolves a non-terminal %s cycle with an unparseable expiresAt to suspended, NOT active (E2, superseded by 059)',
    (status) => {
      // E2 (original intent, preserved) — a corrupt date on a non-terminal
      // cycle must NOT silently read as "in good standing". Post-059, the
      // fail-safe now lives in `deriveMembershipAccess` itself: an
      // unparseable `expiresAt` on a non-terminal cycle is treated as
      // EXPIRED (`!Number.isFinite(expiresMs) || …`), so it resolves to
      // `suspended`/`unpaid` rather than the presentation-layer `error`
      // kind this test asserted pre-059. This is a strictly safer outcome
      // (benefits stay blocked) than the old "Status unavailable" copy,
      // which conveyed no actionable path.
      const stat = deriveMembershipStat(
        cycle({ status: status as RenewalCycle['status'], expiresAt: 'not-a-date' }),
        NOW,
      );
      expect(stat.kind).toBe('suspended');
      expect(stat.variant).toBe('warning');
      expect(stat.reason).toBe('unpaid');
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
    expect(stat.reason).toBeNull();
  });
});

describe('deriveMembershipStat ⟺ isMembershipLapsed (characterization)', () => {
  // The admin lapsed-badge reuses isMembershipLapsed; this pins the
  // equivalence so the step-4 refactor below stays behavior-preserving.
  const PAST = '2026-01-01T00:00:00.000Z';
  const FUTURE = '2027-01-01T00:00:00.000Z';
  const cases: ReadonlyArray<Partial<import('@/modules/renewals').RenewalCycle>> = [
    { status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: PAST },
    { status: 'cancelled', closedAt: PAST, closedReason: 'cancelled', expiresAt: PAST },
    { status: 'completed', closedAt: PAST, closedReason: 'paid', linkedInvoiceId: 'inv1', expiresAt: PAST },
    { status: 'awaiting_payment', expiresAt: PAST },
    { status: 'awaiting_payment', expiresAt: FUTURE },
    { status: 'lapsed', closedAt: PAST, closedReason: 'lapsed', expiresAt: FUTURE },
  ];
  it.each(cases)('kind===lapsed iff isMembershipLapsed for %o', (override) => {
    const c = cycle(override);
    const kindIsLapsed = deriveMembershipStat(c, NOW).kind === 'lapsed';
    expect(kindIsLapsed).toBe(isMembershipLapsed(c, NOW));
  });
});

describe('deriveMembershipStat non-terminal past-expiry regression (post-059-refactor)', () => {
  it('a non-terminal past-expiry cycle stays kind:suspended, NOT lapsed', () => {
    // 059-membership-suspension — this used to assert kind:'overdue' (the
    // pre-suspension destructive state for an expired-but-non-terminal
    // cycle). That condition is now fully absorbed into `suspended`; the
    // one invariant this regression test still guards is that an expired
    // NON-TERMINAL cycle must never be conflated with the TERMINATED
    // `lapsed` kind (only an ENDED-terminal status produces `lapsed`).
    const c = cycle({ status: 'awaiting_payment', expiresAt: '2026-01-01T00:00:00.000Z' });
    const stat = deriveMembershipStat(c, NOW);
    expect(stat.kind).toBe('suspended');
    expect(stat.kind).not.toBe('lapsed');
    expect(stat.reason).toBe('unpaid');
  });
});

describe('deriveOutstandingStat', () => {
  // Bangkok-local "today" the section threads in. All dueDates below
  // relative to this anchor.
  const TODAY_BKK = '2026-06-06';

  // 059-membership-suspension — `id` + `invoiceSubject` are needed for the
  // smart-CTA invoice lookup (`findUnpaidMembershipInvoiceId`), not by
  // `deriveOutstandingStat` itself; default them to arbitrary-but-valid
  // values so these pre-existing fixtures stay minimal.
  function inv(overrides: Partial<Parameters<typeof deriveOutstandingStat>[0][number]>) {
    return { id: 'inv-x', invoiceSubject: 'membership' as const, status: 'issued', totalSatang: 0n, dueDate: null, ...overrides };
  }

  it('sums issued totals and counts them; classifies overdue vs not-yet-due', () => {
    const stat = deriveOutstandingStat(
      [
        inv({ status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' }), // future → not overdue
        inv({ status: 'issued', totalSatang: 53_50n, dueDate: '2026-05-10' }), // past → overdue
        inv({ status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' }),
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
        inv({ status: 'issued', totalSatang: 1_070_00n, dueDate: '2026-06-20' }),
        inv({ status: 'issued', totalSatang: 53_50n, dueDate: '2026-06-30' }),
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
      [inv({ status: 'issued', totalSatang: 100_00n, dueDate: TODAY_BKK })],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('due');
    expect(stat.overdueCount).toBe(0);
  });

  it('treats a null dueDate issued invoice as owing but not overdue', () => {
    const stat = deriveOutstandingStat(
      [inv({ status: 'issued', totalSatang: 100_00n, dueDate: null })],
      TODAY_BKK,
    );
    expect(stat.kind).toBe('due');
    expect(stat.overdueCount).toBe(0);
  });

  it('returns the clear/first-run variant when nothing is owed', () => {
    const stat = deriveOutstandingStat(
      [inv({ status: 'paid', totalSatang: 99_00n, dueDate: '2026-01-01' })],
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

  // 057 D1 review finding C — `member_not_found` is a BENIGN "no plan" empty,
  // NOT a failure. The read layer maps it to `null` (distinct from the
  // `'error'` compute-failure sentinel) so a plan-less member sees the neutral
  // "No benefits yet" empty state rather than a "Benefits unavailable" warning.
  it('returns empty (neutral) when usage is null — benign no-plan, not a failure', () => {
    const stat = deriveBenefitsStat(null);
    expect(stat.kind).toBe('empty');
    expect(stat.variant).toBe('neutral');
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
