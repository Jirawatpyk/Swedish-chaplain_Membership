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
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import {
  listDashboard,
  activityFeedQuery,
  makeListDashboardDeps,
  makeActivityFeedDeps,
} from '@/modules/insights';

/**
 * Staff home page.
 *
 * When `FEATURE_F9_DASHBOARD` is off it shows the F1 placeholder roadmap. When
 * on (F9, US1) it renders the live operations dashboard: KPIs + needs-attention
 * + activity feed + smart insights, served from the cached snapshot (cold-start
 * lazily computes). Managers see a finance-redacted variant; members never
 * reach here (`requireSession('staff')` + listDashboard's own RBAC guard).
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

  // Distinguish a genuine compute failure (snapshot_unavailable / thrown) from
  // the staff-only `forbidden` guard so the user gets the right copy + a retry
  // affordance on failure (FR-006), not a dead-end "empty" message.
  if (!dashResult || !dashResult.ok) {
    const forbidden = dashResult?.ok === false && dashResult.error === 'forbidden';
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        {forbidden ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              {t('forbidden')}
            </CardContent>
          </Card>
        ) : (
          <DashboardErrorState title={t('error.title')} description={t('error.body')} />
        )}
      </DetailContainer>
    );
  }

  const { metrics, computedAt, financeRedacted } = dashResult.value;
  const numberFmt = new Intl.NumberFormat(locale);
  const asOf = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(computedAt));
  const revenueDisplay =
    financeRedacted || metrics.ytdPaidRevenueSatang === null
      ? null
      : new Intl.NumberFormat(locale, {
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
    redactedReason?: string;
  }> = [
    { key: 'total', label: t('kpi.total'), value: numberFmt.format(metrics.counts.total) },
    { key: 'active', label: t('kpi.active'), value: numberFmt.format(metrics.counts.active) },
    { key: 'atRisk', label: t('kpi.atRisk'), value: numberFmt.format(metrics.counts.atRisk) },
    {
      key: 'revenue',
      label: t('kpi.revenue'),
      value: revenueDisplay ?? t('kpi.revenueRedacted'),
      ...(revenueDisplay === null ? { redactedReason: t('kpi.revenueRedactedReason') } : {}),
    },
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

  const insightLines: readonly InsightLine[] = metrics.topInsights.map((insight) => ({
    key: insight.key,
    text: t(`insights.${insight.key}`, { count: insight.count }),
    ...(insight.scopeRef !== undefined ? { scopeRef: insight.scopeRef } : {}),
  }));

  const timeFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const activityItems: readonly ActivityFeedEntry[] = feed.map((item) => ({
    id: item.id,
    summary: item.summary,
    occurredAt: item.occurredAt,
    timeLabel: timeFmt.format(new Date(item.occurredAt)),
  }));

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('asOf', { time: asOf })} />

      <section
        aria-label={t('kpi.sectionLabel')}
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {kpis.map((kpi) => (
          <KpiCard
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
            {...(kpi.redactedReason ? { redactedReason: kpi.redactedReason } : {})}
          />
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
