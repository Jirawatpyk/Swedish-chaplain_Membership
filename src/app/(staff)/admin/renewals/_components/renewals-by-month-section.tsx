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
  formatMonthKeyShort,
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
      band: bandForBucketIndex(i),
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
            {selectedMonthKind !== undefined ? (
              <MonthFilterChip
                monthKind={selectedMonthKind}
                {...(selectedMonthLabel !== undefined
                  ? { monthLabel: selectedMonthLabel }
                  : {})}
              />
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
        {/* Deferred fix-wave-2 T9(a) — wrap in `space-y-1` to mirror the real
            header's `space-y-1` (below); without it the outer `gap-3` gave
            the title+subtitle pair ~8px more vertical space than the real
            render, producing CLS on hydration. */}
        <div className="space-y-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        {/* Mirror the real chart's scroll region + per-column `min-w-11` +
            `overflow-x-auto` so the 14-column strip does not resize/gain a
            scrollbar on hydration (CLS 0). */}
        <div className="overflow-x-auto">
          <div className="flex items-stretch gap-1 px-0.5 pb-1">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="flex min-w-11 flex-1 flex-col items-center gap-1 py-1">
                <div className="flex h-32 w-full items-end justify-center border-b border-border">
                  <Skeleton className="h-24 w-10" />
                </div>
                <div className="flex h-8 items-start">
                  <Skeleton className="h-3 w-8" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
