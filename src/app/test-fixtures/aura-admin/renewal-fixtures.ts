/**
 * 122 US7a (T710) — sample data for the preview's renewals views, as the
 * `Admin-renewals` board draws it: the T-30 stage with five members, the
 * money band, the stage and section counts, "Renewals by month" and the
 * members-without-cycle tray. Figures are sample values, never a tenant's.
 */
import type {
  PipelineMoneySummary,
  PipelineSummary,
  RenewalMonthSummary,
  LoadMembersWithoutCycleOutput,
} from '@/modules/renewals';
import type { PipelineRow } from '@/modules/renewals/client';

/** The instant the preview renders "now" at (Bangkok, 30 Sep 2026). */
export const RENEWALS_NOW_ISO = '2026-09-30T03:00:00.000Z';

const baht = (b: number): bigint => BigInt(Math.round(b * 100));

/** Collection rate 86.0% = settled ÷ (settled + past due). */
export const RENEWALS_MONEY: PipelineMoneySummary = {
  settledDueToDateSatang: baht(1_892_982.86),
  overdueSatang: baht(308_160),
  collectedThisPeriodSatang: baht(412_300),
  dueSoonSatang: baht(186_750),
  overdueBeforeFySatang: baht(21_400),
  overdueBeforeFyCount: 2,
  fyStartDate: '2026-01-01',
};

// [company, tier, expires (BKK date), days since the last reminder]
const T30 = [
  ['Kiruna Mining Services (Thailand)', 'premium', '2026-10-12', 12],
  ['Scandia Health Partners Ltd.', 'premium', '2026-10-15', 9],
  ['Baan Nordic Start-up Co.', 'start_up', '2026-10-18', 6],
  ['Nordvik Logistics (Thailand) Co., Ltd.', 'regular', '2026-10-20', 4],
  ['Midsommar Hospitality Co., Ltd.', 'regular', '2026-10-22', 2],
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export const RENEWAL_ROWS: ReadonlyArray<PipelineRow> = T30.map(
  ([companyName, tierBucket, expires, reminded], i) => ({
    cycleId: `00000000-0000-4000-8000-00000000c00${i + 1}` as PipelineRow['cycleId'],
    memberId: `00000000-0000-4000-8000-00000000a00${i + 1}`,
    companyName,
    tierBucket,
    expiresAt: `${expires}T17:00:00.000Z`,
    urgency: 't-30',
    status: 'reminded',
    lastReminderAt: new Date(Date.parse(RENEWALS_NOW_ISO) - reminded * DAY_MS).toISOString(),
    lastReminderStepId: 't-30',
    linkedInvoiceId: null,
    anchored: false,
    closedReason: null,
    emailUnverified: false,
  }),
);

export const RENEWALS_SUMMARY: PipelineSummary = {
  totalInWindow: 27,
  byUrgency: {
    't-90': 6,
    't-60': 9,
    't-30': 5,
    't-14': 2,
    't-7': 1,
    't-0': 0,
    suspended: 4,
    terminated: 0,
  },
  lapsedCount: 3,
  suspendedOutsideWindowCount: 0,
  suspendedInWindowGlobalCount: 4,
};

/** The empty-state tenant: nothing due in the 90-day window. */
export const RENEWALS_SUMMARY_EMPTY: PipelineSummary = {
  totalInWindow: 0,
  byUrgency: {
    't-90': 0,
    't-60': 0,
    't-30': 0,
    't-14': 0,
    't-7': 0,
    't-0': 0,
    suspended: 0,
    terminated: 0,
  },
  lapsedCount: 0,
  suspendedOutsideWindowCount: 0,
  suspendedInWindowGlobalCount: 0,
};

export const RENEWALS_SECTION_COUNTS = {
  pendingReviewCount: 1,
  tasksCount: 5,
  tierUpgradeCount: 2,
} as const;

export const RENEWALS_NEEDS_ACTION_COUNT = 7;

// Overdue, then Oct 2026 … Oct 2027, then later: 131 open renewals.
const MONTH_COUNTS = [4, 9, 12, 8, 14, 11, 10, 9, 13, 12, 8, 7, 6, 5, 3];
const monthKey = (i: number): string => {
  const m = 9 + i; // index 0 → 2026-10
  return `${2026 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
};

export const RENEWALS_BY_MONTH: RenewalMonthSummary = {
  buckets: MONTH_COUNTS.map((count, i) => ({
    key: i === 0 ? 'overdue' : i === MONTH_COUNTS.length - 1 ? 'later' : monthKey(i - 1),
    count,
  })),
  maxCount: Math.max(...MONTH_COUNTS),
  totalCount: MONTH_COUNTS.reduce((a, b) => a + b, 0),
};

/** The empty view: nothing overdue or due within 90 days (Oct–Dec 2026). */
export const RENEWALS_BY_MONTH_EMPTY_WINDOW: RenewalMonthSummary = (() => {
  const buckets = RENEWALS_BY_MONTH.buckets.map((b, i) => (i <= 3 ? { ...b, count: 0 } : b));
  return {
    buckets,
    maxCount: Math.max(...buckets.map((b) => b.count)),
    totalCount: buckets.reduce((a, b) => a + b.count, 0),
  };
})();

export const MEMBERS_WITHOUT_CYCLE: LoadMembersWithoutCycleOutput = {
  items: [
    {
      memberId: '00000000-0000-4000-8000-00000000b001',
      companyName: 'Nordic Timber Trading Co., Ltd.',
      registrationDate: '2026-09-24',
    },
    {
      memberId: '00000000-0000-4000-8000-00000000b002',
      companyName: 'Visby Software Asia Co., Ltd.',
      registrationDate: '2026-09-19',
    },
  ],
  totalCount: 2,
};

/** The at-risk API's answer for the preview's Needs action lens. */
export const AT_RISK_RESPONSE = {
  items: [
    ['Öresund Marine Engineering Co., Ltd.', 91, 'critical'],
    ['Gotland Foods (Thailand) Ltd.', 78, 'at-risk'],
    ['Lapland Outdoor Gear Co., Ltd.', 74, 'at-risk'],
    ['Malmö Design Studio Co., Ltd.', 71, 'at-risk'],
  ].map(([company, score, band], i) => ({
    member_id: `00000000-0000-4000-8000-00000000d00${i + 1}`,
    company_name: company,
    risk_score: score,
    risk_score_band: band,
    risk_score_last_computed_at: '2026-09-30T00:15:00.000Z',
    risk_snoozed_until: null,
  })),
  next_cursor: null,
  summary: { warning: 5, 'at-risk': 6, critical: 1, f6_active: true, active_max: 100 },
} as const;
