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
import { AlertTriangle, CalendarClock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/shell/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { logger } from '@/lib/logger';
import {
  loadRenewalMonthSummary,
  makeRenewalsDeps,
  barWidthPercent,
  addMonthsToYm,
  bkkYearMonth,
  type RenewalMonthSummary,
} from '@/modules/renewals';
import {
  formatMonthKeyLabel,
  bandForBucketIndex,
  type MonthBarItem,
} from '@/components/renewals/month-bucket-label';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import { MonthFilterChip } from '@/components/renewals/month-filter-chip';

export async function RenewalsByMonthSection({
  tenantSlug,
  nowIso,
  selectedMonth,
}: {
  readonly tenantSlug: string;
  readonly nowIso: string;
  readonly selectedMonth: string | null;
}) {
  const t = await getTranslations('admin.renewals.byMonth');
  const locale = await getLocale();
  const deps = makeRenewalsDeps(tenantSlug);

  let summary: RenewalMonthSummary;
  try {
    const r = await loadRenewalMonthSummary(deps, { tenantId: tenantSlug, nowIso });
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
        <CardContent
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center gap-4 py-12 text-center"
        >
          <AlertTriangle aria-hidden="true" className="h-10 w-10 text-destructive" />
          <div className="text-base font-medium text-destructive">
            {t('loadFailed')}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Resolve labels in Presentation (Constitution III — VM carries none).
  const laterStartKey = addMonthsToYm(bkkYearMonth(nowIso), 12);
  const items: MonthBarItem[] = summary.buckets.map((b, i) => {
    const label =
      b.key === 'overdue'
        ? t('overdue')
        : b.key === 'later'
          ? t('later', { month: formatMonthKeyLabel(laterStartKey, locale) })
          : formatMonthKeyLabel(b.key, locale);
    return {
      key: b.key,
      label,
      count: b.count,
      barPercent: barWidthPercent(b.count, summary.maxCount),
      interactive: b.count > 0,
      band: bandForBucketIndex(i),
    };
  });

  const selectedLabel =
    selectedMonth === null
      ? null
      : (items.find((i) => i.key === selectedMonth)?.label ?? null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <section
          id="renewals-by-month"
          tabIndex={-1}
          aria-labelledby="renewals-by-month-heading"
          className="flex flex-col gap-3 focus-visible:outline-none"
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
            <div className="space-y-1">
              <h2 id="renewals-by-month-heading" className="text-base font-semibold">
                {t('title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('subtitle', { count: summary.totalCount })}
              </p>
            </div>
            {selectedLabel !== null ? (
              <MonthFilterChip monthLabel={selectedLabel} />
            ) : null}
          </div>

          {summary.totalCount === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              bordered={false}
            />
          ) : (
            <MonthBarChart items={items} selectedKey={selectedMonth} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** Suspense fallback — 14 bar placeholders matching the final layout (CLS 0). */
export function RenewalsByMonthSectionSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
        <div className="flex flex-col gap-1">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="flex min-h-11 items-center gap-3 px-2">
              <Skeleton className="h-4 w-40 shrink-0" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-8 shrink-0" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
