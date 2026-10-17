/**
 * Spec 122 US11 (T1108) — the staff dashboard's render, split from
 * `page.tsx` so the AURA preview harness can draw every state from fixtures.
 * The page keeps the guards, the loaders and every format; these components
 * only lay out what it hands them. Synchronous server components: the page
 * passes its own `t`, so a rendered page is still one plain element tree.
 */
import type { getTranslations } from 'next-intl/server';
import { ShieldAlertIcon } from 'lucide-react';
import { Card, Stat, type IconName } from '@jirawatpyk/aura-react/server';
import type { InvoiceStatusDistribution, TierDistributionSlice } from '@/modules/insights';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { CountUp } from '@/components/dashboard/count-up';
import {
  NeedsAttentionList,
  type NeedsAttentionItem,
  type NeedsAttentionUnavailable,
} from '@/components/dashboard/needs-attention-list';
import { InsightsPanel, type InsightLine } from '@/components/dashboard/insights-panel';
import { ActivityFeed, type ActivityFeedEntry } from '@/components/dashboard/activity-feed';
import { DashboardErrorState } from '@/components/dashboard/dashboard-error-state';
import { RevenueTrendChart } from '@/components/dashboard/revenue-trend-chart';
import { MemberGrowthChart } from '@/components/dashboard/member-growth-chart';
import { MembershipTierChart } from '@/components/dashboard/membership-tier-chart';
import { InvoiceStatusChart } from '@/components/dashboard/invoice-status-chart';
import type {
  MiniSeriesDelta,
  MiniSeriesPoint,
  MiniSeriesSummary,
} from '@/components/dashboard/_mini-series-chart';

type DashboardT = Awaited<ReturnType<typeof getTranslations<'admin.dashboard'>>>;
type HomeT = Awaited<ReturnType<typeof getTranslations<'admin.home'>>>;

const ROADMAP_PHASES = ['F3', 'F4', 'F5', 'F6'] as const;

export interface DashboardKpi {
  readonly key: string;
  readonly label: string;
  readonly caption: string;
  readonly rawValue: number;
  readonly variant: 'integer' | 'thb';
  /** AURA icon name (registered once in `@/lib/aura-server-icons`), per board. */
  readonly icon: IconName;
}

/** Present exactly when the viewer holds `insights.finance` (016 T054). */
export interface DashboardFinanceView {
  readonly revenueTrendPoints: readonly MiniSeriesPoint[];
  readonly revenueSummary: MiniSeriesSummary;
  readonly invoiceStatus: InvoiceStatusDistribution;
}

export interface DashboardViewProps {
  readonly t: DashboardT;
  readonly locale: string;
  readonly asOf: string;
  readonly kpis: readonly DashboardKpi[];
  readonly needsAttentionItems: readonly NeedsAttentionItem[];
  readonly needsAttentionUnavailable: readonly NeedsAttentionUnavailable[];
  readonly insightLines: readonly InsightLine[];
  readonly finance: DashboardFinanceView | null;
  readonly memberGrowthPoints: readonly MiniSeriesPoint[];
  readonly memberGrowthSummary: MiniSeriesSummary;
  readonly memberDelta: MiniSeriesDelta | undefined;
  readonly tierDistribution: readonly TierDistributionSlice[];
  readonly activityItems: readonly ActivityFeedEntry[];
}

/** F9 off — the F1 placeholder roadmap card under the page header. */
export function DashboardRoadmap({ tHome }: { readonly tHome: HomeT }) {
  return (
    <Card title={tHome('cardTitle')} description={tHome('cardDescription')} headingLevel={2}>
      <ul className="grid gap-3 aura-text-body">
        {ROADMAP_PHASES.map((phase) => (
          <li key={phase} className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--aura-bg-canvas)] aura-text-caption font-medium text-[var(--aura-fg-primary)]">
              {phase}
            </span>
            <span>
              {tHome(`roadmap.${phase.toLowerCase() as 'f3' | 'f4' | 'f5' | 'f6'}`)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The snapshot could not be read (`error`) or the guard refused (`forbidden`). */
export function DashboardUnavailable({
  t,
  forbidden,
}: {
  readonly t: DashboardT;
  readonly forbidden: boolean;
}) {
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

export function DashboardView({
  t,
  locale,
  asOf,
  kpis,
  needsAttentionItems,
  needsAttentionUnavailable,
  insightLines,
  finance,
  memberGrowthPoints,
  memberGrowthSummary,
  memberDelta,
  tierDistribution,
  activityItems,
}: DashboardViewProps) {
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('asOf', { time: asOf })} />

      {/* 3 tiles without `insights.finance`, 4 with — the column count follows
          so an engagement-only viewer gets an evenly-filled row rather than a
          gap where the revenue tile used to be.
          The 3-tile variant goes straight to `sm:grid-cols-3`. Keeping
          `sm:grid-cols-2` moved the gap rather than closing it: 4 tiles fill a
          2×2 exactly, but 3 tiles leave a half-width hole on the second row for
          every viewport from 640px to 1023px — iPad portrait and any
          split-screen desktop window.
          Both class strings are written out in full: Tailwind scans source
          text, so an interpolated `lg:grid-cols-${n}` would never be
          generated.
          Phones lay the tiles out two up, as board `Admin-dashboard-mobile`
          draws them, while a 9rem tile fits; with enlarged text (200%) they
          fall back to one column instead of scrolling sideways. With three
          tiles the third spans the row either way. */}
      <section
        aria-label={t('kpi.sectionLabel')}
        className={
          finance
            ? 'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4 sm:grid-cols-2 lg:grid-cols-4'
            : 'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4 sm:grid-cols-3 max-sm:[&>*:last-child]:col-[1/-1]'
        }
      >
        {kpis.map((kpi) => (
          <Stat
            key={kpi.key}
            label={kpi.label}
            caption={kpi.caption}
            icon={kpi.icon}
            value={<CountUp value={kpi.rawValue} locale={locale} variant={kpi.variant} compactBelowSm={kpi.variant === 'thb'} />}
          />
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <NeedsAttentionList
          title={t('needsAttention.title')}
          emptyLabel={t('needsAttention.empty')}
          items={needsAttentionItems}
          unavailable={needsAttentionUnavailable}
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

      {/* With finance: Trends (revenue + growth) and Breakdown (tier + AR) are
          two separate 2-up rows, as before.
          Without it, both rows would collapse to ONE card each and the page
          would read as leftovers stacked in a column — a 12-point sparkline
          stretched across the full detail width looks like a bar, not a chart.
          So the two survivors are merged into a single 2-up "Engagement charts"
          row instead, which keeps the finance dashboard's rhythm and halves the
          skeleton mismatch documented in loading.tsx. */}
      {finance ? (
        <>
          <section
            aria-label={t('trends.sectionLabel')}
            className="grid gap-4 lg:grid-cols-2"
          >
            <RevenueTrendChart
              locale={locale}
              title={t('revenueTrend.title')}
              caption={t('revenueTrend.perMonth')}
              emptyLabel={t('revenueTrend.empty')}
              sparseLabel={t('revenueTrend.sparse')}
              monthHeader={t('revenueTrend.month')}
              amountHeader={t('revenueTrend.amount')}
              summary={finance.revenueSummary}
              points={finance.revenueTrendPoints}
            />
            <MemberGrowthChart
              locale={locale}
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

          {/* Breakdown / composition cards (Task 12) — membership-by-tier rows +
              invoice status (stacked bar and rows). Both are self-contained i18n
              (no title/label props — see each component's own docblock) and,
              since spec 122 US11, plain markup with no recharts canvas, so this
              section SSRs whole, its accessible `<ChartDataTable>` included. */}
          <section
            aria-label={t('breakdown.sectionLabel')}
            className="grid gap-4 lg:grid-cols-2"
          >
            <MembershipTierChart slices={tierDistribution} />
            <InvoiceStatusChart distribution={finance.invoiceStatus} />
          </section>
        </>
      ) : (
        <section
          aria-label={t('engagement.sectionLabel')}
          className="grid gap-4 lg:grid-cols-2"
        >
          <MemberGrowthChart
            locale={locale}
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
          <MembershipTierChart slices={tierDistribution} />
        </section>
      )}

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
