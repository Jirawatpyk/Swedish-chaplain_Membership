/**
 * F8 Phase 3 Wave H4 · T071 — `UrgencyBucketTabs` client component.
 *
 * 8-tab navigation for `/admin/renewals` filtered by urgency bucket.
 * Each tab shows a count badge from `summary.by_urgency`. Selecting a
 * tab pushes a new URL `?urgency=<bucket>` so the server re-renders
 * with the filtered page. The lapsed tab is visually segregated from
 * the upcoming buckets to mirror its different operational meaning
 * (FR-046 + spec.md AS3).
 */
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { UrgencyBucket } from '@/modules/renewals';

const TAB_ORDER: ReadonlyArray<UrgencyBucket> = [
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'grace',
  'lapsed',
];

export interface UrgencyBucketTabsProps {
  readonly current: UrgencyBucket;
  readonly counts: Readonly<Record<UrgencyBucket, number>>;
  readonly lapsedCount: number;
}

export function UrgencyBucketTabs({
  current,
  counts,
  lapsedCount,
}: UrgencyBucketTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('admin.renewals.urgencyBuckets');

  function handleChange(value: string) {
    if (!TAB_ORDER.includes(value as UrgencyBucket)) return;
    const next = new URLSearchParams(params.toString());
    next.set('urgency', value);
    next.delete('cursor'); // reset pagination on tab switch
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    // Outer wrapper handles horizontal scroll at narrow viewports
    // (WCAG 1.4.10 Reflow). TabsList itself is `inline-flex w-fit` from
    // base-ui, so `overflow-x-auto` only takes effect on the wrapper.
    <div className="w-full overflow-x-auto">
      <Tabs value={current} onValueChange={handleChange}>
        <TabsList className="min-w-max" aria-label={t('aria_label')}>
          {TAB_ORDER.map((bucket) => {
          const count =
            bucket === 'lapsed' ? lapsedCount : (counts[bucket] ?? 0);
          const i18nKey = bucket.replace('-', '_');
          return (
            <TabsTrigger
              key={bucket}
              value={bucket}
              className={cn(
                bucket === 'lapsed' && 'ml-2 border-l border-border pl-3',
              )}
            >
              <span>
                {t(
                  i18nKey as
                    | 't_90'
                    | 't_60'
                    | 't_30'
                    | 't_14'
                    | 't_7'
                    | 't_0'
                    | 'grace'
                    | 'lapsed',
                )}
              </span>
              <span
                className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
                aria-hidden
              >
                {count}
              </span>
              <span className="sr-only">
                {t('countSr', { count })}
              </span>
            </TabsTrigger>
          );
        })}
        </TabsList>
      </Tabs>
    </div>
  );
}
