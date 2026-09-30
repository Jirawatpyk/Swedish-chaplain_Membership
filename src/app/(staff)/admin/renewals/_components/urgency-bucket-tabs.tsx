/**
 * F8 Phase 3 Wave H4 · T071 — `UrgencyBucketTabs` client component.
 *
 * The stage chips for `/admin/renewals`: T-90 … T-0, Suspended and
 * Terminated, each with its count (Terminated counts the lapsed cycles).
 * A chip is a link to `?urgency=<bucket>`, so the server re-renders the
 * filtered page; choosing one exits the month lens and resets the paging
 * cursor and its `nowIso` anchor.
 *
 * 122 US7a (T703): AURA link tabs on a desktop (board `Admin-renewals`) and
 * an "Urgency" select on a phone (board `Admin-renewals-mobile`). Links
 * rather than tabs: with a month lens active no chip is current, which a
 * tablist cannot express. Neither control scrolls the page to the top
 * (operator report: the jump yanked the user away from the strip). While a
 * month lens is active the chips show a visible "Paused" badge and each is
 * described by the hint explaining why (item ③).
 */
'use client';

import { forwardRef, type ComponentProps } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Select, Tabs, type TabItem } from '@jirawatpyk/aura-react';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { UrgencyBucket } from '@/modules/renewals/client';

const TAB_ORDER: ReadonlyArray<UrgencyBucket> = [
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'suspended',
  'terminated',
];

type DashToUnderscore<S extends string> = S extends `${infer A}-${infer B}`
  ? `${A}_${DashToUnderscore<B>}`
  : S;
type UrgencyI18nKey = DashToUnderscore<(typeof TAB_ORDER)[number]>;

const MONTH_LENS_HINT_ID = 'urgency-month-lens-hint';

/** A chip link that keeps the scroll position (same-page filter). */
const NoScrollLink = forwardRef<HTMLAnchorElement, ComponentProps<typeof Link>>(
  function NoScrollLink(props, ref) {
    return <Link ref={ref} {...props} scroll={false} />;
  },
);

export interface UrgencyBucketTabsProps {
  /** The current bucket; `null` while a month lens is active (no chip current). */
  readonly current: UrgencyBucket | null;
  readonly counts: Readonly<Record<UrgencyBucket, number>>;
  /** Terminated shows the lapsed-cycle count. */
  readonly lapsedCount: number;
  /** Item ③ — a month lens is active, so the chips are paused. */
  readonly monthLensActive?: boolean;
}

export function UrgencyBucketTabs({
  current,
  counts,
  lapsedCount,
  monthLensActive = false,
}: UrgencyBucketTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('admin.renewals.urgencyBuckets');
  const tTable = useTranslations('admin.renewals.table');

  const hrefFor = (bucket: UrgencyBucket): string => {
    const next = new URLSearchParams(params.toString());
    next.set('urgency', bucket);
    next.delete('month'); // mutually-exclusive lens — exit the month lens
    next.delete('cursor'); // reset pagination on a chip change
    next.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
    return `${pathname}?${next.toString()}`;
  };

  const chips = TAB_ORDER.map((bucket) => {
    const count = bucket === 'terminated' ? lapsedCount : (counts[bucket] ?? 0);
    const i18nKey = bucket.replaceAll('-', '_') as UrgencyI18nKey;
    const label = t.has(i18nKey) ? t(i18nKey) : `${i18nKey} (untranslated)`;
    return { bucket, count, label };
  });

  const tabs: TabItem[] = chips.map(({ bucket, count, label }) => ({
    id: bucket,
    label,
    count,
    href: hrefFor(bucket),
    // The name reads "T-90, 6 members" (the label first, WCAG 2.5.3).
    tabProps: {
      'aria-label': `${label}, ${t('countSr', { count })}`,
      ...(monthLensActive ? { 'aria-describedby': MONTH_LENS_HINT_ID } : {}),
    },
  }));

  return (
    <>
      {monthLensActive ? (
        <span id={MONTH_LENS_HINT_ID} className="sr-only">
          {t('monthLensHint')}
        </span>
      ) : null}
      <div className="flex min-w-0 items-center gap-[var(--aura-space-2)] max-sm:hidden">
        <Tabs
          label={t('aria_label')}
          tabs={tabs}
          linkComponent={NoScrollLink}
          {...(current !== null ? { value: current } : {})}
        />
        {/* Item ③ — visible "Paused" badge beside the chips; hidden from
            screen readers, which hear the hint on each chip instead. */}
        {monthLensActive ? (
          <span aria-hidden className="shrink-0">
            <Badge tone="neutral" icon="clock">
              {t('monthLensBadge')}
            </Badge>
          </span>
        ) : null}
      </div>
      {/* The phone board draws the stages as a select. */}
      <div className="sm:hidden">
        <Select
          label={tTable('columns.urgency')}
          value={current ?? ''}
          placeholder={monthLensActive ? t('monthLensBadge') : undefined}
          // Same hint the chips carry: why no stage is chosen.
          {...(monthLensActive ? { 'aria-describedby': MONTH_LENS_HINT_ID } : {})}
          options={chips.map(({ bucket, count, label }) => ({
            value: bucket,
            label: `${label} (${count})`,
          }))}
          onChange={(e) => {
            const bucket = TAB_ORDER.find((b) => b === e.target.value);
            if (bucket) router.push(hrefFor(bucket), { scroll: false });
          }}
        />
      </div>
    </>
  );
}
