/**
 * Renewals-by-month — vertical bar chart (client).
 *
 * A `<ul role="list">` rendered as columns inside a focusable `role="region"`
 * scroll wrapper (WCAG 2.1.1 — mirrors `ui/table.tsx` + the sibling
 * `urgency-bucket-tabs.tsx` on this page). One bar per bucket, height ∝
 * count/maxCount (a % of the plot, capped to leave room for the count on top),
 * with the count on the bar and a compact month label below. Each NONZERO
 * bucket is a `<Link>` to `?month=<key>` (soft-nav; clears `?urgency` + `?tier`
 * + `?cursor` — the month lens is whole-tenant). Zero buckets render as a
 * non-interactive `role="img"` column (baseline + label only, out of tab
 * order). The selected bucket gets `aria-current` + an OUTSET ring + a tinted
 * column + bolder count (non-colour affordance, WCAG 1.4.1).
 *
 * Bar fills use a dedicated SOLID scale (`BAR_FILL_CLASSES`) — the SAME hue
 * language as `UrgencyPill` (slate→amber→orange→red, no blue) but tuned as
 * fill-area marks, not the pill's near-white text-on-tint chip weights. The
 * edge is a `border` (not `ring`) so the selection `ring` composes cleanly
 * (an inset base ring would defeat the themed selection ring in dark mode and
 * occlude a MIN_BAR_PERCENT-floored short bar).
 */
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { ChartBand, MonthBarItem } from '@/components/renewals/month-bucket-label';

// Solid bar fills, keyed by the 4 bands `bandForBucketIndex` actually returns
// (same slate→amber→orange→red hue language as UrgencyPill, no blue).
const BAR_FILL_CLASSES: Record<ChartBand, string> = {
  't-0': 'bg-red-500 dark:bg-red-500',
  't-7': 'bg-orange-500 dark:bg-orange-400',
  't-14': 'bg-amber-500 dark:bg-amber-400',
  't-90': 'bg-slate-500 dark:bg-slate-400',
};

/** Shared column layout — used by both the interactive and zero branches so a
 *  spacing tweak can't misalign one against the shared baseline. */
const COLUMN_CLASSES = 'flex flex-col items-center gap-1 rounded-md px-0.5 py-1';

export interface MonthBarChartProps {
  readonly items: ReadonlyArray<MonthBarItem>;
  readonly selectedKey: string | null;
}

export function MonthBarChart({
  items,
  selectedKey,
}: MonthBarChartProps): React.JSX.Element {
  const t = useTranslations('admin.renewals.byMonth');
  const params = useSearchParams();

  function hrefFor(key: string): string {
    const next = new URLSearchParams(params.toString());
    next.set('month', key);
    next.delete('urgency'); // mutually-exclusive lens
    next.delete('tier'); // whole-tenant lens — clear tier so the dropdown can't lie
    next.delete('cursor'); // reset pagination
    next.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
    return `/admin/renewals?${next.toString()}`;
  }

  return (
    // Focusable scroll region so keyboard users can pan the columns when they
    // overflow on narrow viewports (WCAG 2.1.1 scrollable-region-focusable —
    // same fix as ui/table.tsx + urgency-bucket-tabs.tsx). `px-0.5` on the list
    // reserves room for the first/last column's focus ring (WCAG 2.4.7).
    <div
      role="region"
      aria-label={t('chartScrollAriaLabel')}
      tabIndex={0}
      className="overflow-x-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ul role="list" aria-label={t('listAriaLabel')} className="flex items-stretch gap-1 px-0.5 pb-1">
        {items.map((item) => {
          const fillClass = BAR_FILL_CLASSES[item.band];
          const isSelected = selectedKey === item.key;
          const ariaLabel = item.interactive
            ? t('bucketAriaLabel', { label: item.label, count: item.count })
            : t('zeroBucketAriaLabel', { label: item.label });

          const inner = (
            <>
              {/* plot — fixed height; the [count, bar] group is bottom-aligned to
                  the baseline rule, so the number always sits on its bar and every
                  bar shares the axis. `border-b` grounds the many zero columns. */}
              <span className="flex h-32 w-full flex-col items-center justify-end gap-0.5 border-b border-border">
                {/* Count sits on the bar. Zero months still show a faint "0" at
                    the baseline so an empty month reads as "0 renewals", not a
                    rendering gap (the bar itself is absent for count 0). */}
                <span
                  className={cn(
                    'text-xs leading-none tabular-nums',
                    item.count > 0 ? 'text-foreground' : 'text-muted-foreground',
                    isSelected && 'font-bold',
                  )}
                >
                  {item.count}
                </span>
                {/* Bar only for nonzero counts — a 0-height bar with a border
                    would clamp to a ~2px band-coloured tick and misread as a
                    tiny value. Height is a % of the plot (scales with h-32),
                    capped so the count always fits above even the tallest bar. */}
                {item.count > 0 ? (
                  <span
                    aria-hidden
                    className={cn(
                      'w-10 rounded-t border border-black/10 dark:border-white/15',
                      fillClass,
                      isSelected && 'ring-2 ring-ring ring-offset-1 ring-offset-card',
                    )}
                    style={{ height: `${item.barPercent}%`, maxHeight: 'calc(100% - 1.25rem)' }}
                  />
                ) : null}
              </span>
              {/* compact axis label (BE-aware short month); `title` restores the
                  full label as a hover affordance for sighted mouse users. */}
              <span
                title={item.label}
                className="h-8 w-full text-center text-[11px] leading-tight text-muted-foreground"
              >
                {item.shortLabel}
              </span>
            </>
          );

          return (
            <li key={item.key} className="min-w-11 flex-1">
              {item.interactive ? (
                <Link
                  href={hrefFor(item.key)}
                  aria-label={ariaLabel}
                  aria-current={isSelected ? 'true' : undefined}
                  className={cn(
                    COLUMN_CLASSES,
                    'transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isSelected && 'bg-muted/60',
                  )}
                >
                  {inner}
                </Link>
              ) : (
                <div
                  role="img"
                  aria-label={ariaLabel}
                  className={cn(COLUMN_CLASSES, isSelected && 'bg-muted/60')}
                >
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
