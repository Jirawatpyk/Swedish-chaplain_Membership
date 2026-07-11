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
// Client-safe sub-barrel — see `tier-filter-select.tsx` for rationale.
import type { UrgencyBucket } from '@/modules/renewals/client';
import { VARIANT_CLASSES } from '@/components/renewals/urgency-pill';

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

/**
 * K8-M5: derive the i18n-key literal union from `TAB_ORDER` so adding
 * a 9th bucket becomes a one-line `TAB_ORDER` change rather than two
 * (the const tuple AND the inline literal cast at the `t()` call).
 * The transform mirrors what the `bucket.replace('-', '_')` runtime
 * call does at the type level: 't-90' → 't_90'.
 */
type DashToUnderscore<S extends string> = S extends `${infer A}-${infer B}`
  ? `${A}_${DashToUnderscore<B>}`
  : S;
type UrgencyI18nKey = DashToUnderscore<(typeof TAB_ORDER)[number]>;

export interface UrgencyBucketTabsProps {
  readonly current: UrgencyBucket | null;
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
    next.delete('month'); // mutually-exclusive lens — exit the month lens
    next.delete('cursor'); // reset pagination on tab switch
    next.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    // Outer wrapper handles horizontal scroll at narrow viewports
    // (WCAG 1.4.10 Reflow). TabsList itself is `inline-flex w-fit` from
    // base-ui, so `overflow-x-auto` only takes effect on the wrapper.
    //
    // `overflow-y-hidden` is required: per CSS overflow spec, setting
    // `overflow-x: auto` implicitly forces `overflow-y` to `auto` too
    // (the spec disallows mixing `visible` with any non-visible
    // value on the other axis). The TabsList's content is `33px` tall
    // due to `p-[3px]` + `h-8` rounding, which overflows the 32px
    // wrapper by 1px and triggers vertical scroll-arrow chevrons
    // ("^" / "v") when the user clicks a tab. Forcing Y-hidden clips
    // that 1px ghost overflow without affecting any visible tab
    // content (the default-variant `:after` indicator is opacity-0).
    //
    // `py-0.5` adds 2px breathing room above + below so a focus ring
    // on edge-row tabs isn't clipped by the Y-hidden boundary
    // (WCAG 2.4.11 Focus Not Obscured).
    // 067 a11y (WCAG 2.1.1 scrollable-region-focusable, deterministic on
    // WebKit) — an overflow-x-auto container that scrolls must be keyboard-
    // pan-scrollable. Mirror src/components/ui/table.tsx: tabIndex makes the
    // region focusable (arrow keys scroll it), role=region + aria-label name
    // the landmark, focus ring meets WCAG 2.4.7.
    // 067 #4 review-fix — the scroll region uses a DISTINCT label from the
    // inner TabsList (`aria_label`); two nested named landmarks announcing the
    // same phrase ("Filter by renewal urgency") was a double-announce nit.
    <div
      role="region"
      aria-label={t('aria_label_scroll')}
      tabIndex={0}
      className="w-full overflow-x-auto overflow-y-hidden py-0.5 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
    >
      <Tabs value={current ?? ''} onValueChange={handleChange}>
        {/* `gap-1` separates adjacent triggers — without it the count
            badge of one tab visually butts against the next tab's
            label, producing the unreadable "T-90 0T-60 0T-14 0" run.
            shadcn's default TabsList variant has no inter-trigger gap
            because shadcn assumes each trigger is a single short word;
            pairs of <label, badge> need explicit breathing room. */}
        {/* Phase 6 review-round 2 Cmt7 — arrow-key navigation provided by
            shadcn `<Tabs>` automatically (Radix Tabs primitive). No need
            to duplicate the manual `tablist` arrow handler used by
            `at-risk-widget.tsx` (custom `<div role="tablist">`-based
            tabs); both surfaces meet the same WCAG outcome via
            different implementations. */}
        <TabsList className="min-w-max gap-1" aria-label={t('aria_label')}>
          {TAB_ORDER.map((bucket) => {
          const count =
            bucket === 'lapsed' ? lapsedCount : (counts[bucket] ?? 0);
          // Phase 6 review-round 2 UX-M3 — replaceAll is future-proof
          // for multi-hyphen bucket strings (current set has at most
          // one hyphen, so behaviour is identical today).
          const i18nKey = bucket.replaceAll('-', '_') as UrgencyI18nKey;
          // Phase 6 review-round 2 F8 — loud-fail when a TAB_ORDER
          // entry is added without the matching i18n key. next-intl's
          // default `getMessageFallback` returns the key string,
          // silently rendering "t_45" instead of localized text.
          const label = t.has(i18nKey)
            ? t(i18nKey)
            : `${i18nKey} (untranslated)`;
          return (
            <TabsTrigger
              key={bucket}
              value={bucket}
              className={cn(
                bucket === 'lapsed' && 'ml-2 border-l border-border pl-3',
              )}
            >
              <span>{label}</span>
              <span
                className={cn(
                  'ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-xs font-medium ring-1 ring-inset tabular-nums',
                  VARIANT_CLASSES[bucket],
                )}
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
