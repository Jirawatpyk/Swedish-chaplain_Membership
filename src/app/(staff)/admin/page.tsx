import type { Metadata } from 'next';
import { randomUUID } from 'node:crypto';
import { getTranslations, getLocale } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { KpiCard } from '@/components/dashboard/kpi-card';
import {
  NeedsAttentionList,
  type NeedsAttentionItem,
} from '@/components/dashboard/needs-attention-list';
import { InsightsPanel, type InsightLine } from '@/components/dashboard/insights-panel';
import {
  ActivityFeed,
  type ActivityFeedEntry,
} from '@/components/dashboard/activity-feed';
import { DashboardErrorState } from '@/components/dashboard/dashboard-error-state';
import { RevenueTrendChart } from '@/components/dashboard/revenue-trend-chart';
import { MemberGrowthChart } from '@/components/dashboard/member-growth-chart';
import { EmptyState } from '@/components/shell/empty-state';
import { ShieldAlertIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { resolveEventLabel } from '@/lib/audit-event-label';
import {
  listDashboard,
  activityFeedQuery,
  listSmartInsights,
  makeListDashboardDeps,
  makeActivityFeedDeps,
  makeListSmartInsightsDeps,
} from '@/modules/insights';

/**
 * Staff home page.
 *
 * When `FEATURE_F9_DASHBOARD` is off it shows the F1 placeholder roadmap. When
 * on (F9, US1) it renders the live operations dashboard: KPIs + needs-attention
 * + activity feed + smart insights, served from the cached snapshot (cold-start
 * lazily computes). Admins and the "read-only on finance" manager role both see
 * the full dashboard incl. revenue (FR-007); members never reach here
 * (`requireSession('staff')` + listDashboard's own RBAC guard).
 */
export const metadata: Metadata = {
  title: 'Staff home',
};

const ROADMAP_PHASES = ['F3', 'F4', 'F5', 'F6'] as const;

export default async function StaffHomePage() {
  const { user } = await requireSession('staff');

  if (!env.features.f9Dashboard) {
    const tShell = await getTranslations('shell');
    const tHome = await getTranslations('admin.home');
    return (
      <DetailContainer>
        <PageHeader
          title={
            user.displayName
              ? tHome('welcomeWithName', { name: user.displayName })
              : tShell('welcome')
          }
          subtitle={tHome('subtitle', { role: user.role })}
        />
        <Card>
          <CardHeader>
            <CardTitle>{tHome('cardTitle')}</CardTitle>
            <CardDescription>{tHome('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 text-body">
              {ROADMAP_PHASES.map((phase) => (
                <li key={phase} className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-caption font-medium">
                    {phase}
                  </span>
                  <span>
                    {tHome(`roadmap.${phase.toLowerCase() as 'f3' | 'f4' | 'f5' | 'f6'}`)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  // --- F9 operations dashboard ---------------------------------------------
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('admin.dashboard');
  const locale = await getLocale();
  const meta = {
    actorUserId: user.id as string,
    actorRole: user.role,
    requestId: randomUUID(),
  };

  // allSettled (not all) so a thrown activity-feed read can never take down the
  // whole dashboard — the feed is the least-critical widget (FR-003 vs FR-005).
  const [dashSettled, feedSettled] = await Promise.allSettled([
    listDashboard(meta, tenant, makeListDashboardDeps(tenant.slug)),
    activityFeedQuery({ limit: 15 }, meta, tenant, makeActivityFeedDeps()),
  ]);
  const dashResult = dashSettled.status === 'fulfilled' ? dashSettled.value : null;

  if (dashSettled.status === 'rejected') {
    // The dashboard's PRIMARY widget threw outside the Result channel (e.g. a
    // Neon outage in snapshotRepo.read → runInTenant). Log it — otherwise an
    // operator sees the error state with a log line for the feed (below) but
    // nothing for the headline failure. Mirrors the activity-feed handling.
    logger.error(
      { tenantId: tenant.slug, errKind: errKind(dashSettled.reason) },
      'insights.dashboard.list_dashboard_rejected',
    );
  }

  // Distinguish a genuine compute failure (snapshot_unavailable / thrown) from
  // the staff-only `forbidden` guard so the user gets the right copy + a retry
  // affordance on failure (FR-006), not a dead-end "empty" message.
  if (!dashResult || !dashResult.ok) {
    const forbidden = dashResult?.ok === false && dashResult.error === 'forbidden';
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        {forbidden ? (
          <EmptyState icon={ShieldAlertIcon} title={t('forbidden')} />
        ) : (
          <DashboardErrorState title={t('error.title')} description={t('error.body')} />
        )}
      </DetailContainer>
    );
  }

  const { metrics, computedAt } = dashResult.value;
  const numberFmt = new Intl.NumberFormat(locale);
  const asOf = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    // Render the "as of" instant in the tenant timezone — the Vercel runtime is
    // UTC, so without this the th-TH label shows UTC midnight, not Asia/Bangkok
    // (mirrors the audit page's dual-timestamp fix).
    timeZone: env.tenant.timezone,
  }).format(new Date(computedAt));
  // FR-007: revenue is visible to all staff (admin + the "read-only on finance"
  // manager role); only members are denied the dashboard (handled upstream).
  const revenueDisplay = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 0,
  }).format(Number(metrics.ytdPaidRevenueSatang) / 100);

  if (feedSettled.status === 'rejected') {
    // The adapter swallows source read errors to [] (logged upstream), so a
    // rejection here is an UNEXPECTED throw outside it — log so it isn't fully
    // invisible. The dashboard still renders with an empty feed.
    logger.warn(
      { tenantId: tenant.slug, errKind: errKind(feedSettled.reason) },
      'insights.dashboard.activity_feed_rejected',
    );
  }
  const feed =
    feedSettled.status === 'fulfilled' && feedSettled.value.ok ? feedSettled.value.value : [];

  const kpis: ReadonlyArray<{
    key: string;
    label: string;
    value: string;
  }> = [
    { key: 'total', label: t('kpi.total'), value: numberFmt.format(metrics.counts.total) },
    { key: 'active', label: t('kpi.active'), value: numberFmt.format(metrics.counts.active) },
    { key: 'atRisk', label: t('kpi.atRisk'), value: numberFmt.format(metrics.counts.atRisk) },
    { key: 'revenue', label: t('kpi.revenue'), value: revenueDisplay },
  ];

  // Only surface items that actually need attention (FR-006) — a "0" with a
  // dead-end link is noise; when all are zero the list shows an "all clear" state.
  const needsAttentionItems: readonly NeedsAttentionItem[] = (
    [
      {
        id: 'overdueInvoices',
        n: metrics.needsAttention.overdueInvoices,
        label: t('needsAttention.overdueInvoices'),
        href: '/admin/invoices?status=issued',
      },
      {
        id: 'atRisk',
        n: metrics.needsAttention.atRiskMembers,
        label: t('needsAttention.atRisk'),
        href: '/admin/members?risk_band=at-risk',
      },
      {
        id: 'broadcasts',
        n: metrics.needsAttention.broadcastsAwaitingApproval,
        label: t('needsAttention.broadcasts'),
        href: '/admin/broadcasts',
      },
    ] as const
  )
    .filter((item) => item.n > 0)
    .map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      count: numberFmt.format(item.n),
    }));

  // Live-filter insights against current dismissals (T028) so a just-dismissed
  // insight disappears on refresh without waiting for the ~5-min cron recompute.
  const liveInsights = await listSmartInsights(tenant, makeListSmartInsightsDeps(tenant.slug));
  const topInsights = liveInsights.ok ? liveInsights.value : metrics.topInsights;
  const insightLines: readonly InsightLine[] = topInsights.map((insight) => ({
    key: insight.key,
    text: t(`insights.${insight.key}`, { count: insight.count }),
    ...(insight.scopeRef !== undefined ? { scopeRef: insight.scopeRef } : {}),
  }));

  const timeFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const tEvents = await getTranslations('admin.dashboard.activity.events');
  const activityItems: readonly ActivityFeedEntry[] = feed.map((item) => ({
    id: item.id,
    // Localised action label (FR-034) — resolved per-locale from the audit
    // event type, NOT the raw English summary (which would leak to TH/SV).
    // Uncatalogued types fall back to a humanised token (no English sentence).
    label: resolveEventLabel(tEvents, item.eventType),
    occurredAt: item.occurredAt,
    timeLabel: timeFmt.format(new Date(item.occurredAt)),
  }));

  // FR-001a trend charts — display-ready points (visible to all staff; the
  // empty state shows only when a tenant genuinely has no paid revenue yet).
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' });
  const thbFmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 0,
  });
  const monthLabel = (key: string): string =>
    monthFmt.format(new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
  const revenueTrendPoints = metrics.revenueTrend.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: Number(p.satang),
    valueLabel: thbFmt.format(Number(p.satang) / 100),
  }));
  const memberGrowthPoints = metrics.memberGrowth.map((p) => ({
    key: p.month,
    label: monthLabel(p.month),
    value: p.cumulative,
    valueLabel: numberFmt.format(p.cumulative),
  }));
  // At-a-glance summary stats above each sparkline (readability).
  const revenueTotalSatang = metrics.revenueTrend.reduce((s, p) => s + BigInt(p.satang), 0n);
  const revenueSummary = {
    value: thbFmt.format(Number(revenueTotalSatang) / 100),
    label: t('revenueTrend.total'),
  };
  const memberGrowthSummary = {
    value: numberFmt.format(metrics.memberGrowth.at(-1)?.cumulative ?? 0),
    label: t('memberGrowth.total'),
  };
  const revenueTrendEmpty = t('revenueTrend.empty');
  // Net-new members over the window (cumulative is monotonic) → an "▲ +N"
  // growth chip, only when there's actual growth (avoids a flat/▼ noise chip).
  const memberNetNew =
    (metrics.memberGrowth.at(-1)?.cumulative ?? 0) - (metrics.memberGrowth[0]?.cumulative ?? 0);
  const memberDelta =
    memberNetNew > 0
      ? { direction: 'up' as const, label: t('memberGrowth.netNew', { count: memberNetNew }) }
      : undefined;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('asOf', { time: asOf })} />

      <section
        aria-label={t('kpi.sectionLabel')}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {kpis.map((kpi) => (
          <KpiCard key={kpi.key} label={kpi.label} value={kpi.value} />
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <NeedsAttentionList
          title={t('needsAttention.title')}
          emptyLabel={t('needsAttention.empty')}
          items={needsAttentionItems}
        />
        <InsightsPanel
          title={t('insights.title')}
          emptyLabel={t('insights.empty')}
          dismissLabel={t('insights.dismiss')}
          dismissedLabel={t('insights.dismissed')}
          dismissErrorLabel={t('insights.dismissError')}
          lines={insightLines}
        />
      </div>

      <section aria-label={t('trends.sectionLabel')} className="grid gap-4 lg:grid-cols-2">
        <RevenueTrendChart
          title={t('revenueTrend.title')}
          caption={t('revenueTrend.perMonth')}
          emptyLabel={revenueTrendEmpty}
          sparseLabel={t('revenueTrend.sparse')}
          monthHeader={t('revenueTrend.month')}
          amountHeader={t('revenueTrend.amount')}
          summary={revenueSummary}
          points={revenueTrendPoints}
        />
        <MemberGrowthChart
          title={t('memberGrowth.title')}
          caption={t('memberGrowth.cumulative')}
          emptyLabel={t('memberGrowth.empty')}
          sparseLabel={t('memberGrowth.sparse')}
          monthHeader={t('memberGrowth.month')}
          countHeader={t('memberGrowth.count')}
          summary={memberGrowthSummary}
          {...(memberDelta ? { delta: memberDelta } : {})}
          points={memberGrowthPoints}
        />
      </section>

      <ActivityFeed
        title={t('activity.title')}
        emptyLabel={t('activity.empty')}
        refreshLabel={t('activity.refresh')}
        refreshedLabel={t('activity.refreshed')}
        items={activityItems}
      />
    </DetailContainer>
  );
}
