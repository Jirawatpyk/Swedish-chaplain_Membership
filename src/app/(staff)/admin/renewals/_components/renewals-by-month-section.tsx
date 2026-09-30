/**
 * Renewals-by-month — async server section for `/admin/renewals`.
 *
 * Calls `loadRenewalMonthSummary`, resolves each bucket's localized label
 * (BE-aware month+year via `formatMonthKeyLabel`; `overdue`/`later` via
 * next-intl), computes bar widths + urgency band, and hands a serialisable
 * view-model to the client `<MonthBarChart>`. Own `<section aria-labelledby>`
 * + a REAL `<h2>` (not shadcn CardTitle, which renders a `<div>`).
 * Best-effort error handling: an infra throw renders a "couldn't load" card
 * so it never crashes the page.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { Alert, Card, EmptyState } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { logger } from '@/lib/logger';
import {
  type loadRenewalMonthSummary,
  barWidthPercent,
  addMonthsToYm,
  bkkYearMonth,
  type RenewalMonthSummary,
} from '@/modules/renewals';
import type { Settled } from '../_lib/settled';
import {
  formatMonthKeyLabel,
  formatMonthKeyShort,
  type MonthBarItem,
} from '@/components/renewals/month-bucket-label';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import { MonthFilterChip } from '@/components/renewals/month-filter-chip';

export async function RenewalsByMonthSection({
  tenantSlug,
  nowIso,
  selectedMonth,
  summaryPromise,
}: {
  readonly tenantSlug: string;
  readonly nowIso: string;
  readonly selectedMonth: string | null;
  /**
   * Waterfall fix (eager-island pattern, `_lib/settled.ts`) — the page
   * CREATES this `loadRenewalMonthSummary` promise BEFORE its blocking
   * `await loadPipeline`, so the aggregation runs concurrently with the
   * pipeline query instead of starting after it. Settled at creation (a
   * pre-mount rejection can never be an unhandled rejection); the unwrap
   * below re-throws `e` INSIDE the pre-existing try so the catch renders
   * the exact same "couldn't load" card as before. The page passes the SAME
   * `nowIso` into the promise and this prop — the chart/pipeline
   * reconciliation invariant is unchanged.
   */
  readonly summaryPromise: Promise<
    Settled<Awaited<ReturnType<typeof loadRenewalMonthSummary>>>
  >;
}) {
  const t = await getTranslations('admin.renewals.byMonth');
  const locale = await getLocale();

  let summary: RenewalMonthSummary;
  try {
    const settled = await summaryPromise;
    if (!settled.ok) throw settled.e;
    const r = settled.v;
    // Error channel is `never` today; THROW if a real variant is ever added so
    // the catch renders "couldn't load" instead of a silently empty chart.
    if (!r.ok) {
      throw new Error('loadRenewalMonthSummary returned an unexpected error');
    }
    summary = r.value;
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.RENEWALS_BY_MONTH_LOAD',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] renewals-by-month load failed',
    );
    return (
      <Card>
        <Alert tone="danger" title={t('loadFailed')} />
      </Card>
    );
  }

  // Resolve labels in Presentation (Constitution III — VM carries none).
  const laterStartKey = addMonthsToYm(bkkYearMonth(nowIso), 12);
  const items: MonthBarItem[] = summary.buckets.map((b) => {
    // Compute the bucket kind ONCE, then branch on it for both the full label
    // (accessible name) and the compact axis short label — so the two can never
    // diverge on which case applies (mirrors the `selectedMonthKind` idiom below).
    const kind: 'overdue' | 'later' | 'month' =
      b.key === 'overdue' ? 'overdue' : b.key === 'later' ? 'later' : 'month';
    const label =
      kind === 'overdue'
        ? t('overdue')
        : kind === 'later'
          ? t('later', { month: formatMonthKeyLabel(laterStartKey, locale) })
          : formatMonthKeyLabel(b.key, locale);
    const shortLabel =
      kind === 'overdue'
        ? t('overdueShort')
        : kind === 'later'
          ? t('laterShort', { month: formatMonthKeyShort(laterStartKey, locale) })
          : formatMonthKeyShort(b.key, locale);
    return {
      key: b.key,
      label,
      shortLabel,
      count: b.count,
      barPercent: barWidthPercent(b.count, summary.maxCount),
      interactive: b.count > 0,
    };
  });

  // Deferred fix-wave-2 #4 — the chip needs a discriminator + a BARE month
  // label (no "Renewing in …" frame), derived directly from `selectedMonth`
  // + `nowIso` rather than reused from `items[].label` (those are the
  // chart-bar labels, e.g. "Overdue" / "{month} or later", which stay
  // exactly as-is). `laterStartKey` is the SAME BKK+12 key computed above
  // for the chart bars, so the chip and chart read identically.
  const selectedMonthKind: 'overdue' | 'later' | 'month' | undefined =
    selectedMonth === null
      ? undefined
      : selectedMonth === 'overdue'
        ? 'overdue'
        : selectedMonth === 'later'
          ? 'later'
          : 'month';
  const selectedMonthLabel =
    selectedMonthKind === undefined || selectedMonthKind === 'overdue'
      ? undefined
      : selectedMonthKind === 'later'
        ? formatMonthKeyLabel(laterStartKey, locale)
        : formatMonthKeyLabel(selectedMonth as string, locale);

  // The card is the focus target the month chip returns focus to
  // (`#renewals-by-month`), labelled by its own title.
  return (
    <Card
      as="section"
      id="renewals-by-month"
      tabIndex={-1}
      className="focus-visible:outline-none"
      title={t('title')}
      titleId="renewals-by-month-heading"
      headingLevel={2}
      description={t('subtitle', { count: summary.totalCount })}
      actions={
        selectedMonthKind !== undefined ? (
          <MonthFilterChip
            monthKind={selectedMonthKind}
            {...(selectedMonthLabel !== undefined ? { monthLabel: selectedMonthLabel } : {})}
          />
        ) : undefined
      }
    >
      {summary.totalCount === 0 ? (
        <EmptyState
          icon="calendar"
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          headingLevel={false}
        />
      ) : (
        <MonthBarChart items={items} selectedKey={selectedMonth} />
      )}
    </Card>
  );
}

export function RenewalsByMonthSectionSkeleton() {
  return (
    <Card
      header={
        <div className="flex flex-col gap-[var(--aura-space-1)]">
          <SkeletonBlock className="h-5 w-48" />
          <SkeletonBlock className="h-4 w-64" />
        </div>
      }
    >
      {/* Mirror the real chart's scroll region + per-column `min-w-11` so the
          14-column strip does not resize or gain a scrollbar on hydration
          (CLS 0). */}
      <div className="overflow-x-auto">
        <div className="flex items-stretch gap-1 px-0.5 pb-1">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex min-w-11 flex-1 flex-col items-center gap-1 py-1">
              <div className="flex h-32 w-full items-end justify-center border-b border-[var(--aura-chart-axis)]">
                <SkeletonBlock className="h-24 w-10" />
              </div>
              <div className="flex h-8 items-start">
                <SkeletonBlock className="h-3 w-8" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
