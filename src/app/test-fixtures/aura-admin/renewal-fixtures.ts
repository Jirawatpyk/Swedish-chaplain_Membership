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

// ── US7b-1: cycle detail (`Admin-renewal-cycle*`) and the tier upgrade
// queue (`Admin-tier-upgrades*`). Values the page would format (money in
// next-intl's THB currency style, dates `dateStyle: 'long'`) are given
// formatted; labels come from the messages in the preview page.

export const CYCLE_PREVIEW_ID = '00000000-0000-4000-8000-00000000c101';

export type CycleFixtureKind = 'bill-issued' | 'reminded' | 'pending';

export interface CycleFixture {
  readonly status: 'awaiting_payment' | 'reminded' | 'pending_admin_reactivation';
  readonly company: string;
  readonly primaryContact: string;
  readonly tier: 'partnership' | 'premium' | 'start_up';
  readonly planName: string;
  readonly frozenPrice: string;
  readonly subtitleDate: string;
  readonly invoice: { readonly number: string; readonly status: 'issued' | 'paid'; readonly total: string } | null;
  readonly period: { readonly from: string; readonly to: string; readonly expires: string; readonly enteredPending?: string };
  readonly reminders: ReadonlyArray<{ readonly stepId: string; readonly status: 'sent'; readonly date: string; readonly channel: 'email' | 'task' }>;
  readonly escalations: ReadonlyArray<{
    readonly taskType: 'quarterly_review_meeting' | 'phone_call';
    readonly status: 'open' | 'done';
    readonly date: string;
    readonly role: 'executive_director' | 'admin';
  }>;
}

export const CYCLE_FIXTURES: Readonly<Record<CycleFixtureKind, CycleFixture>> = {
  'bill-issued': {
    status: 'awaiting_payment',
    company: 'Lindqvist & Chai Group Co., Ltd.',
    primaryContact: 'Mattias Lindqvist',
    tier: 'partnership',
    planName: 'Gold Partnership',
    frozenPrice: 'THB 100,000.00',
    subtitleDate: '31 December 2026',
    invoice: { number: 'SC-2026-000130', status: 'issued', total: 'THB 107,000.00' },
    period: { from: '1 January 2027', to: '31 December 2027', expires: '31 December 2026' },
    reminders: [
      { stepId: 't-120.task.quarterly_review', status: 'sent', date: '2 September 2026 at 09:00', channel: 'task' },
    ],
    escalations: [
      { taskType: 'quarterly_review_meeting', status: 'done', date: '2 September 2026 at 09:00', role: 'executive_director' },
    ],
  },
  reminded: {
    status: 'reminded',
    company: 'Scandia Health Partners Ltd.',
    primaryContact: 'Karin Holm',
    tier: 'premium',
    planName: 'Premium Corporate',
    frozenPrice: 'THB 36,000.00',
    subtitleDate: '15 October 2026',
    invoice: null,
    period: { from: '16 October 2026', to: '15 October 2027', expires: '15 October 2026' },
    reminders: [
      { stepId: 't-90.email', status: 'sent', date: '17 July 2026 at 09:00', channel: 'email' },
      { stepId: 't-60.email', status: 'sent', date: '16 August 2026 at 09:00', channel: 'email' },
      { stepId: 't-60.task.phone_call', status: 'sent', date: '16 August 2026 at 09:00', channel: 'task' },
      { stepId: 't-30.email', status: 'sent', date: '15 September 2026 at 09:00', channel: 'email' },
    ],
    escalations: [{ taskType: 'phone_call', status: 'open', date: '16 August 2026 at 09:00', role: 'admin' }],
  },
  pending: {
    status: 'pending_admin_reactivation',
    company: 'Gamla Stan Coffee Roasters',
    primaryContact: 'Nattapong Wongsa',
    tier: 'start_up',
    planName: 'Start-up',
    frozenPrice: 'THB 10,000.00',
    subtitleDate: '21 September 2026',
    invoice: { number: 'SC-2026-000131', status: 'paid', total: 'THB 10,700.00' },
    period: {
      from: '16 July 2025',
      to: '15 July 2026',
      expires: '15 July 2026',
      enteredPending: '21 September 2026 at 10:12',
    },
    reminders: [],
    escalations: [],
  },
};

/** The queue's rows, as the page hands them to `TierUpgradeQueueClient`. */
export const TIER_UPGRADE_ITEMS = [
  {
    suggestionId: '00000000-0000-4000-8000-00000000e001',
    memberId: '00000000-0000-4000-8000-00000000e101',
    companyName: 'Baltic Bay Consulting Co., Ltd.',
    status: 'open',
    fromPlanId: 'large-corporate',
    fromPlanName: 'Large Corporate',
    fromFeeMinorUnits: 2_600_000,
    toPlanId: 'premium-corporate',
    toPlanName: 'Premium Corporate',
    toFeeMinorUnits: 3_600_000,
    reasonCode: 'declared_turnover_above_threshold',
    evidence: {
      reasonCode: 'declared_turnover_above_threshold',
      turnoverThb: 142_000_000,
      thresholdMetAtLabel: '14 Sep 2026',
    },
    createdAt: '2026-09-14T00:00:00.000Z',
  },
  {
    suggestionId: '00000000-0000-4000-8000-00000000e002',
    memberId: '00000000-0000-4000-8000-00000000e102',
    companyName: 'Chao Phraya Design Studio Co., Ltd.',
    status: 'open',
    fromPlanId: 'regular-corporate',
    fromPlanName: 'Regular Corporate',
    fromFeeMinorUnits: 1_600_000,
    toPlanId: 'large-corporate',
    toPlanName: 'Large Corporate',
    toFeeMinorUnits: 2_600_000,
    reasonCode: 'paid_invoice_volume_above_threshold',
    evidence: {
      reasonCode: 'paid_invoice_volume_above_threshold',
      invoiceVolumeThb: 34_240,
      thresholdMetAtLabel: '21 Sep 2026',
    },
    createdAt: '2026-09-21T00:00:00.000Z',
  },
] as const;

// ── 122 US7b-2 ──────────────────────────────────────────────────────────

/** An ISO date `days` from now, so overdue rows stay overdue on any day. */
function fromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/** The escalation queue's rows (board `Admin-renewal-tasks`), as the page maps them. */
export const TASK_ITEMS = [
  {
    taskId: '00000000-0000-4000-8000-00000000f001',
    memberId: '00000000-0000-4000-8000-00000000f101',
    memberCompanyName: 'Gamla Stan Coffee Roasters',
    memberTierBucket: 'start_up',
    cycleId: null,
    cycleExpiresAt: fromNow(-78),
    taskType: 'admin_notify_lapsed',
    assignedToRole: 'admin',
    assignedToUserId: '00000000-0000-4000-8000-00000000a001',
    assignedToDisplayName: 'Malin Berg',
    assignedToEmail: 'malin.berg@example.com',
    dueAt: fromNow(-71),
    status: 'open',
    createdAt: fromNow(-80),
    yearInCycle: 1,
    totalYears: 1,
  },
  {
    taskId: '00000000-0000-4000-8000-00000000f002',
    memberId: '00000000-0000-4000-8000-00000000f102',
    memberCompanyName: 'Andaman Marine Tech Co., Ltd.',
    memberTierBucket: 'partnership',
    cycleId: null,
    cycleExpiresAt: fromNow(91),
    taskType: 'quarterly_review_meeting',
    assignedToRole: 'executive_director',
    assignedToUserId: null,
    assignedToDisplayName: null,
    assignedToEmail: null,
    dueAt: fromNow(-29),
    status: 'open',
    createdAt: fromNow(-35),
    yearInCycle: 2,
    totalYears: 3,
  },
  {
    taskId: '00000000-0000-4000-8000-00000000f003',
    memberId: '00000000-0000-4000-8000-00000000f103',
    memberCompanyName: 'Öresund Medical Supplies Co., Ltd.',
    memberTierBucket: 'premium',
    cycleId: null,
    cycleExpiresAt: fromNow(29),
    taskType: 'phone_call',
    assignedToRole: 'admin',
    assignedToUserId: '00000000-0000-4000-8000-00000000a002',
    assignedToDisplayName: 'Karin Ek',
    assignedToEmail: 'karin.ek@example.com',
    dueAt: fromNow(2),
    status: 'open',
    createdAt: fromNow(-5),
    yearInCycle: 1,
    totalYears: 1,
  },
  {
    taskId: '00000000-0000-4000-8000-00000000f004',
    memberId: '00000000-0000-4000-8000-00000000f104',
    memberCompanyName: 'Nordvik Logistics (Thailand) Co., Ltd.',
    memberTierBucket: 'regular',
    cycleId: null,
    cycleExpiresAt: fromNow(14),
    taskType: 'phone_call',
    assignedToRole: 'admin',
    assignedToUserId: '00000000-0000-4000-8000-00000000a001',
    assignedToDisplayName: 'Malin Berg',
    assignedToEmail: 'malin.berg@example.com',
    dueAt: fromNow(-5),
    status: 'open',
    createdAt: fromNow(-12),
    yearInCycle: 1,
    totalYears: 1,
  },
  {
    taskId: '00000000-0000-4000-8000-00000000f005',
    memberId: '00000000-0000-4000-8000-00000000f105',
    memberCompanyName: 'Scandia Health Partners Ltd.',
    memberTierBucket: 'premium',
    cycleId: null,
    cycleExpiresAt: fromNow(45),
    taskType: 'in_person_meeting',
    assignedToRole: 'manager',
    assignedToUserId: null,
    assignedToDisplayName: null,
    assignedToEmail: null,
    dueAt: fromNow(9),
    status: 'open',
    createdAt: fromNow(-2),
    yearInCycle: 1,
    totalYears: 1,
  },
] as const;

/** The distinct task types the server reads for the Task type select. */
export const TASK_TYPES = ['admin_notify_lapsed', 'in_person_meeting', 'phone_call', 'quarterly_review_meeting'] as const;

/** One saved policy per tier (board `Admin-renewal-schedules`, Premium drawn). */
export const SCHEDULE_POLICIES = [
  {
    tier_bucket: 'premium',
    updated_at: '2026-09-02T07:20:00.000Z',
    steps: [
      { step_id: 't-90.email', offset_days: -90, channel: 'email', template_id: 'renewal.t-90.premium' },
      { step_id: 't-60.email', offset_days: -60, channel: 'email', template_id: 'renewal.t-60.premium' },
      { step_id: 't-60.task.phone_call', offset_days: -60, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
      { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.premium' },
      { step_id: 't-14.email', offset_days: -14, channel: 'email', template_id: 'renewal.t-14.premium' },
      { step_id: 't-7.email', offset_days: -7, channel: 'email', template_id: 'renewal.t-7.premium' },
      { step_id: 't-7.task.quarterly_review_meeting', offset_days: -7, channel: 'task', task_type: 'quarterly_review_meeting', assignee_role: 'executive_director' },
      { step_id: 't+0.email', offset_days: 0, channel: 'email', template_id: 'renewal.t+0.premium' },
      { step_id: 't+14.task.phone_call', offset_days: 14, channel: 'task', task_type: 'phone_call', assignee_role: 'admin' },
    ],
  },
  {
    tier_bucket: 'regular',
    updated_at: '2026-08-20T03:00:00.000Z',
    steps: [
      { step_id: 't-60.email', offset_days: -60, channel: 'email', template_id: 'renewal.t-60.regular' },
      { step_id: 't-30.email', offset_days: -30, channel: 'email', template_id: 'renewal.t-30.regular' },
      { step_id: 't-7.email', offset_days: -7, channel: 'email', template_id: 'renewal.t-7.regular' },
    ],
  },
] as const;
