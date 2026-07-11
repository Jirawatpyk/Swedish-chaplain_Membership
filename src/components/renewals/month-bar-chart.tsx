/**
 * Renewals-by-month — vertical bar chart (client).
 *
 * A `<ul role="list">` rendered as columns: one bar per bucket, height ∝
 * count/maxCount, with the count on top of the bar and a compact month label
 * below. Each NONZERO bucket is a `<Link>` to `?month=<key>` (soft-nav; clears
 * `?urgency` + `?tier` + `?cursor` — the month lens is whole-tenant, mirroring
 * the reverse clears in the urgency tabs / tier select). Zero buckets render as
 * a non-interactive `role="img"` column (baseline + label only, out of tab
 * order — the "0 in July" signal reads via the empty column + its aria-label).
 * The selected bucket gets `aria-current` + a ring + a tinted column + bolder
 * count (non-colour affordance, WCAG 1.4.1).
 *
 * Bar fills use a dedicated SOLID scale (`BAR_FILL_CLASSES`) — the SAME hue
 * language as `UrgencyPill` (slate→amber→orange→red, no blue) but tuned as
 * fill-area marks, not the pill's text-on-tint chip weights (which rendered as
 * near-white boxes here and failed the graphical-object contrast at the exact
 * bars that matter most). Keyed by the same `UrgencyBucket` so the mapping
 * stays 1:1 with the pills.
 */
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import type { UrgencyBucket } from '@/modules/renewals/client';

const BAR_FILL_CLASSES: Record<UrgencyBucket, string> = {
  't-90': 'bg-slate-500 dark:bg-slate-400',
  't-60': 'bg-slate-500 dark:bg-slate-400',
  't-30': 'bg-amber-500 dark:bg-amber-400',
  't-14': 'bg-amber-500 dark:bg-amber-400',
  't-7': 'bg-orange-500 dark:bg-orange-400',
  't-0': 'bg-red-500 dark:bg-red-500',
  grace: 'bg-red-500 dark:bg-red-500',
  lapsed: 'bg-gray-400 dark:bg-gray-500',
};

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
    // `px-0.5` reserves room for the first/last column's focus ring against the
    // `overflow-x-auto` edge (WCAG 2.4.7).
    <ul
      role="list"
      aria-label={t('listAriaLabel')}
      className="flex items-stretch gap-1 overflow-x-auto px-0.5 pb-1"
    >
      {items.map((item) => {
        const fillClass = BAR_FILL_CLASSES[item.band];
        const isSelected = selectedKey === item.key;
        const ariaLabel = item.interactive
          ? t('bucketAriaLabel', { label: item.label, count: item.count })
          : t('zeroBucketAriaLabel', { label: item.label });

        const inner = (
          <>
            {/* plot — fixed height; the [count, bar] group is bottom-aligned to
                the baseline rule, so the number always sits right on its bar and
                every bar shares the axis. `border-b` grounds the chart so the
                many zero columns read as "0 on the axis", not blank space. */}
            <span className="flex h-32 w-full flex-col items-center justify-end gap-0.5 border-b border-border">
              {item.count > 0 ? (
                <span
                  className={cn(
                    'text-xs leading-none tabular-nums text-foreground',
                    isSelected && 'font-bold',
                  )}
                >
                  {item.count}
                </span>
              ) : null}
              <span
                aria-hidden
                className={cn(
                  'w-10 rounded-t ring-1 ring-inset ring-black/10 dark:ring-white/15',
                  fillClass,
                  isSelected && 'ring-2 ring-ring ring-offset-1 ring-offset-card',
                )}
                style={{ height: `${item.barPercent}px` }}
              />
            </span>
            {/* compact axis label (BE-aware short month) */}
            <span className="h-8 w-full text-center text-[11px] leading-tight text-muted-foreground">
              {item.shortLabel || item.label}
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
                  'flex flex-col items-center gap-1 rounded-md px-0.5 py-1 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'bg-muted/60',
                )}
              >
                {inner}
              </Link>
            ) : (
              <div
                role="img"
                aria-label={ariaLabel}
                className="flex flex-col items-center gap-1 px-0.5 py-1"
              >
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
