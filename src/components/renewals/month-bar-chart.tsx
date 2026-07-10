/**
 * Renewals-by-month — horizontal bar list (client).
 *
 * A `<ul role="list">` of `label │ bar │ count` rows; each NONZERO bucket row
 * is a full-width `<Link>` to `?month=<key>` (soft-nav; clears `?urgency` +
 * `?cursor`, mirroring the urgency-tabs contract). Zero buckets render
 * non-interactive (muted, `aria-disabled`, out of tab order — the "0 in July"
 * signal still aids planning). The selected bucket gets `aria-current` + a ring
 * + bolder count (non-colour affordance, WCAG 1.4.1). Band colours reuse the
 * shipped `UrgencyPill` palette (slate→amber→orange→red) so the chart, the
 * polished tabs, and the pills speak ONE colour language. No blue.
 */
'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { VARIANT_CLASSES } from '@/components/renewals/urgency-pill';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import type { UrgencyBucket } from '@/modules/renewals/client';

export interface MonthBarChartProps {
  readonly items: ReadonlyArray<MonthBarItem>;
  readonly selectedKey: string | null;
}

/**
 * Bucket-position → representative urgency bucket, so the bar band reuses the
 * pill's exact Tailwind class string. Order: [overdue, m0, m1, m2, m3…m11, later].
 *   overdue → red (t-0) · m0 → orange (t-7) · m1-m2 → amber (t-14) · rest → slate (t-90)
 */
function bandBucketForIndex(i: number): UrgencyBucket {
  if (i === 0) return 't-0';
  if (i === 1) return 't-7';
  if (i === 2 || i === 3) return 't-14';
  return 't-90';
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
    next.delete('cursor'); // reset pagination
    return `/admin/renewals?${next.toString()}`;
  }

  return (
    <ul role="list" aria-label={t('listAriaLabel')} className="flex flex-col gap-1">
      {items.map((item, i) => {
        const bandClass = VARIANT_CLASSES[bandBucketForIndex(i)];
        const isSelected = selectedKey === item.key;
        const rowLabel = item.interactive
          ? t('bucketAriaLabel', { label: item.label, count: item.count })
          : t('zeroBucketAriaLabel', { label: item.label });

        const inner = (
          <>
            <span className="w-40 shrink-0 truncate text-sm text-foreground">
              {item.label}
            </span>
            <span className="relative h-4 flex-1 overflow-hidden rounded bg-muted/40">
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-0 left-0 rounded ring-1 ring-inset',
                  bandClass,
                )}
                style={{ width: `${item.barPercent}%` }}
              />
            </span>
            <span
              className={cn(
                'w-8 shrink-0 text-right text-sm tabular-nums',
                isSelected ? 'font-bold text-foreground' : 'font-medium text-muted-foreground',
              )}
            >
              {item.count}
            </span>
          </>
        );

        return (
          <li key={item.key}>
            {item.interactive ? (
              <Link
                href={hrefFor(item.key)}
                aria-label={rowLabel}
                aria-current={isSelected ? 'true' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 rounded-md px-2 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'ring-2 ring-inset ring-ring',
                )}
              >
                {inner}
              </Link>
            ) : (
              <div
                aria-disabled="true"
                aria-label={rowLabel}
                className="flex min-h-11 items-center gap-3 rounded-md px-2 opacity-60"
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
