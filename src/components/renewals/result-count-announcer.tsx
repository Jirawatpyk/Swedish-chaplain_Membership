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
  /** The active urgency-tab key (`t-90` / `t-60` / … / `lapsed`). */
  readonly urgencyKey:
    | 't-90'
    | 't-60'
    | 't-30'
    | 't-14'
    | 't-7'
    | 't-0'
    | 'grace'
    | 'lapsed';
}

export function ResultCountAnnouncer({
  count,
  urgencyKey,
}: ResultCountAnnouncerProps) {
  const tTable = useTranslations('admin.renewals.table');
  const tBuckets = useTranslations('admin.renewals.urgencyBuckets');
  // Translation keys use snake-case (`t_90`); the URL param uses
  // hyphens (`t-90`) — convert before lookup.
  const bucketKey = urgencyKey.replace('-', '_') as
    | 't_90'
    | 't_60'
    | 't_30'
    | 't_14'
    | 't_7'
    | 't_0'
    | 'grace'
    | 'lapsed';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {tTable('srResultCount', {
        count,
        urgency: tBuckets(bucketKey),
      })}
    </div>
  );
}
