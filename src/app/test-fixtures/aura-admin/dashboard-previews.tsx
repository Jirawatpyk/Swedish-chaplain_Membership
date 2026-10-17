/**
 * Spec 122 US11 (T1108) — the staff dashboard drawn from fixtures through the
 * page's own render (`dashboard-view.tsx`), with the same formats the page
 * uses. States: default (admin, finance) · engagement (no `insights.finance`)
 * · empty-charts (a new tenant) · attention-unavailable (the change-request
 * count could not be read) · insights-empty · forbidden · error · flag-off.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import type { InvoiceStatusDistribution, TierDistributionSlice } from '@/modules/insights';
import type { ActivityFeedEntry } from '@/components/dashboard/activity-feed';
import {
  DashboardRoadmap,
  DashboardUnavailable,
  DashboardView,
  type DashboardKpi,
} from '@/app/(staff)/admin/(home)/_components/dashboard-view';

/** Satang per month for the 12-month revenue trend (Nov 2025 → Oct 2026). */
const REVENUE_SATANG = [
  1_850_000, 0, 642_000, 4_280_000, 1_070_000, 2_140_000, 0, 856_000, 3_852_000, 12_840_000, 5_350_000, 2_996_000,
];
/** Cumulative active members per month. */
const MEMBER_CUMULATIVE = [112, 113, 115, 115, 118, 120, 121, 121, 124, 127, 130, 131];
const MONTHS = [
  '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
  '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
];

const TIERS: readonly TierDistributionSlice[] = [
  { tierKey: 'corporate-gold', label: { en: 'Corporate Gold', th: 'องค์กร โกลด์', sv: 'Företag Guld' }, count: 46 },
  { tierKey: 'corporate-silver', label: { en: 'Corporate Silver', th: 'องค์กร ซิลเวอร์', sv: 'Företag Silver' }, count: 38 },
  { tierKey: 'sme', label: { en: 'SME', th: 'SME', sv: 'SME' }, count: 24 },
  { tierKey: 'individual', label: { en: 'Individual', th: 'บุคคล', sv: 'Individ' }, count: 13 },
  { tierKey: 'unassigned', label: { en: 'unassigned' }, count: 3 },
];

const INVOICE_STATUS: InvoiceStatusDistribution = {
  buckets: [
    { bucket: 'paid', satang: '412630000', count: 98 },
    { bucket: 'unpaid', satang: '61560000', count: 14 },
    { bucket: 'overdue', satang: '23540000', count: 6 },
  ],
  draftCount: 2,
};

const ACTIVITY: readonly Omit<ActivityFeedEntry, 'timeLabel' | 'absoluteLabel'>[] = [
  { id: 'a1', actor: 'Anna Lindqvist', label: 'Payment recorded', occurredAt: '2026-10-16T03:12:00.000Z', href: '/admin/audit?targetRef=u-1' },
  { id: 'a2', actor: 'Somchai Prasert', label: 'Member updated', occurredAt: '2026-10-16T02:40:00.000Z' },
  { id: 'a3', label: 'Renewal reminder sent', occurredAt: '2026-10-16T00:05:00.000Z' },
  { id: 'a4', actor: 'Anna Lindqvist', label: 'Invoice issued', occurredAt: '2026-10-15T09:31:00.000Z', href: '/admin/audit?targetRef=u-2' },
  { id: 'a5', actor: 'Johan Strand', label: 'E-Blast approved', occurredAt: '2026-10-15T04:18:00.000Z' },
];
const ACTIVITY_LABELS: Record<string, { readonly relative: string; readonly absolute: string }> = {
  a1: { relative: '8 minutes ago', absolute: '16 Oct 2026, 10:12' },
  a2: { relative: '40 minutes ago', absolute: '16 Oct 2026, 09:40' },
  a3: { relative: '3 hours ago', absolute: '16 Oct 2026, 07:05' },
  a4: { relative: 'Yesterday', absolute: '15 Oct 2026, 16:31' },
  a5: { relative: 'Yesterday', absolute: '15 Oct 2026, 11:18' },
};

export async function renderDashboardPreview(state: string | undefined) {
  const t = await getTranslations('admin.dashboard');
  const locale = await getLocale();

  if (state === 'flag-off') {
    const tShell = await getTranslations('shell');
    const tHome = await getTranslations('admin.home');
    return (
      <DetailContainer>
        <PageHeader title={tShell('welcome')} subtitle={tHome('subtitle', { role: 'admin' })} />
        <DashboardRoadmap tHome={tHome} />
      </DetailContainer>
    );
  }
  if (state === 'forbidden' || state === 'error') {
    return <DashboardUnavailable t={t} forbidden={state === 'forbidden'} />;
  }

  const finance = state !== 'engagement';
  const empty = state === 'empty-charts';
  const numberFmt = new Intl.NumberFormat(locale);
  const thbFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: 'THB', maximumFractionDigits: 0 });
  const monthFmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), { month: 'short', year: 'numeric' });
  const monthLabel = (key: string) =>
    monthFmt.format(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
  const axisMonthFmt = new Intl.DateTimeFormat(getDateFormatLocale(locale), { month: 'short' });
  const axisMonthLabel = (key: string) =>
    axisMonthFmt.format(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));

  const kpis: DashboardKpi[] = [
    { key: 'total', label: t('kpi.total'), caption: t('kpi.totalCaption'), rawValue: empty ? 0 : 148, variant: 'integer', icon: 'users' },
    { key: 'active', label: t('kpi.active'), caption: t('kpi.activeCaption'), rawValue: empty ? 0 : 131, variant: 'integer', icon: 'circle-check' },
    { key: 'atRisk', label: t('kpi.atRisk'), caption: t('kpi.atRiskCaption'), rawValue: empty ? 0 : 9, variant: 'integer', icon: 'triangle-alert' },
    ...(finance
      ? [{ key: 'revenue', label: t('kpi.revenue'), caption: t('kpi.revenueCaption'), rawValue: empty ? 0 : 381_450, variant: 'thb', icon: 'trending-up' } as const]
      : []),
  ];

  const revenueTrendPoints = MONTHS.map((month, i) => {
    const satang = empty ? 0 : REVENUE_SATANG[i]!;
    return { key: month, label: monthLabel(month), axisLabel: axisMonthLabel(month), value: satang, valueLabel: thbFmt.format(satang / 100) };
  });
  const memberGrowthPoints = MONTHS.map((month, i) => {
    const n = empty ? 0 : MEMBER_CUMULATIVE[i]!;
    return { key: month, label: monthLabel(month), axisLabel: axisMonthLabel(month), value: n, valueLabel: numberFmt.format(n) };
  });
  const revenueTotal = revenueTrendPoints.reduce((s, p) => s + p.value, 0);
  const netNew = empty ? 0 : MEMBER_CUMULATIVE.at(-1)! - MEMBER_CUMULATIVE[0]!;

  const attention = empty
    ? []
    : [
        ...(finance ? [{ id: 'overdueInvoices', label: t('needsAttention.overdueInvoices'), href: '/admin/invoices?status=overdue', count: numberFmt.format(6), tone: 'danger' as const }] : []),
        { id: 'atRisk', label: t('needsAttention.atRisk'), href: '/admin/members?risk_band=critical,at-risk,warning', count: numberFmt.format(9) },
        { id: 'broadcasts', label: t('needsAttention.broadcasts'), href: '/admin/broadcasts', count: numberFmt.format(2) },
        ...(state === 'attention-unavailable'
          ? []
          : [{ id: 'changeRequests', label: t('needsAttention.changeRequests', { days: 3 }), href: '/admin/change-requests', count: numberFmt.format(3) }]),
      ];

  const insightLines =
    empty || state === 'insights-empty'
      ? []
      : [
          { key: 'at_risk_followup', text: t('insights.at_risk_followup', { count: 5 }) },
          { key: 'unused_eblast_quota', text: t('insights.unused_eblast_quota', { count: 50 }) },
          { key: 'underused_event_tickets', text: t('insights.underused_event_tickets', { count: 12 }) },
        ];

  return (
    <DashboardView
      t={t}
      locale={locale}
      asOf="16 Oct 2026, 10:20"
      kpis={kpis}
      needsAttentionItems={attention}
      needsAttentionUnavailable={
        state === 'attention-unavailable'
          ? [{ id: 'change-requests', label: t('needsAttention.changeRequestsUnavailable') }]
          : []
      }
      insightLines={insightLines}
      finance={
        finance
          ? {
              revenueTrendPoints,
              revenueSummary: { value: thbFmt.format(revenueTotal / 100), label: t('revenueTrend.total') },
              invoiceStatus: empty ? { buckets: [], draftCount: 0 } : INVOICE_STATUS,
            }
          : null
      }
      memberGrowthPoints={memberGrowthPoints}
      memberGrowthSummary={{ value: numberFmt.format(memberGrowthPoints.at(-1)!.value), label: t('memberGrowth.total') }}
      memberDelta={netNew > 0 ? { direction: 'up', label: t('memberGrowth.netNew', { count: netNew }) } : undefined}
      tierDistribution={empty ? [] : TIERS}
      activityItems={
        empty
          ? []
          : ACTIVITY.map((a) => ({ ...a, timeLabel: ACTIVITY_LABELS[a.id]!.relative, absoluteLabel: ACTIVITY_LABELS[a.id]!.absolute }))
      }
    />
  );
}
