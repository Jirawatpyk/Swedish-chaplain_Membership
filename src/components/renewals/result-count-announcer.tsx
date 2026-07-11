/**
 * J8-M27 — Result-count `aria-live` announcer (client component).
 *
 * The renewal pipeline page is a Next.js server component. When the
 * admin changes the urgency tab or tier filter, the URL params drive
 * an RSC re-render — Next streams a new HTML payload that replaces
 * the page content. Server-rendered `<div role="status" aria-live>`
 * regions placed inside that re-rendered tree may NOT re-announce
 * to screen readers reliably because the announcer-DOM gets
 * replaced wholesale rather than text-mutated in place.
 *
 * Extracting the announcer into a client component pins it to the
 * client React tree where text-content changes (driven by prop
 * updates) trigger the SR re-announce contract that
 * `aria-live="polite"` requires. The live region stays mounted
 * across navigations + RSC streaming — only the text changes.
 *
 * Used by `src/app/(staff)/admin/renewals/page.tsx`.
 */
'use client';

import { useTranslations } from 'next-intl';

export interface ResultCountAnnouncerProps {
  /** Number of pipeline rows visible after server-side filter. */
  readonly count: number;
  /** The active urgency-tab key — omit when the month lens is active. */
  readonly urgencyKey?:
    | 't-90'
    | 't-60'
    | 't-30'
    | 't-14'
    | 't-7'
    | 't-0'
    | 'grace'
    | 'lapsed';
  /** When set, announces the month lens instead of the urgency bucket. */
  readonly monthLabel?: string;
  /**
   * Discriminates the month-lens announcement — `overdue`/`later` get
   * dedicated grammatical strings instead of composing `monthLabel` into
   * the generic "renewing in {month}" frame (deferred fix-wave-2 #4).
   * Absent (undefined) preserves the pre-existing `monthLabel`-only
   * behaviour.
   */
  readonly monthKind?: 'overdue' | 'later' | 'month';
}

export function ResultCountAnnouncer({
  count,
  urgencyKey,
  monthLabel,
  monthKind,
}: ResultCountAnnouncerProps) {
  const tTable = useTranslations('admin.renewals.table');
  const tBuckets = useTranslations('admin.renewals.urgencyBuckets');
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {monthKind === 'overdue'
        ? tTable('srResultCountOverdue', { count })
        : monthKind === 'later' && monthLabel !== undefined
          ? tTable('srResultCountLater', { count, month: monthLabel })
          : (monthKind === 'month' || monthKind === undefined) &&
              monthLabel !== undefined
            ? tTable('srResultCountMonth', { count, month: monthLabel })
            : urgencyKey !== undefined
              ? tTable('srResultCount', {
                  count,
                  // URL param uses hyphens (`t-90`); i18n keys use snake (`t_90`).
                  urgency: tBuckets(urgencyKey.replace('-', '_')),
                })
              : ''}
    </div>
  );
}
