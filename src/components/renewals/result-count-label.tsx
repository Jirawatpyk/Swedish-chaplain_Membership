/**
 * Wave 1 Task 2 (item ④) — Sighted results-count label (client) — the
 * visible twin of `ResultCountAnnouncer`. `aria-hidden` because the
 * sr-only announcer already owns the screen-reader channel (mirrors the
 * urgency count-badge pattern: visible badge `aria-hidden` + sr-only
 * `countSr`). Reuses the same `admin.renewals.table.srResultCount*`
 * message keys so the two surfaces can never drift.
 *
 * Rendered next to the filter row on `/admin/renewals` so a mouse/
 * keyboard admin can see "Showing N members in T-30" without needing a
 * screen reader — `ResultCountAnnouncer` stays mounted, unchanged,
 * announcing the same text to assistive tech.
 */
'use client';

import { useTranslations } from 'next-intl';

export interface ResultCountLabelProps {
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
    | 'suspended'
    | 'terminated';
  /** When set, shows the month lens instead of the urgency bucket. */
  readonly monthLabel?: string;
  /**
   * Discriminates the month-lens copy — `overdue`/`later` get dedicated
   * grammatical strings instead of composing `monthLabel` into the
   * generic "renewing in {month}" frame. Absent (undefined) preserves
   * the `monthLabel`-only behaviour. Mirrors `ResultCountAnnouncerProps`.
   */
  readonly monthKind?: 'overdue' | 'later' | 'month';
}

export function ResultCountLabel({
  count,
  urgencyKey,
  monthLabel,
  monthKind,
}: ResultCountLabelProps) {
  const tTable = useTranslations('admin.renewals.table');
  const tBuckets = useTranslations('admin.renewals.urgencyBuckets');
  const text =
    monthKind === 'overdue'
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
            : '';
  if (text === '') return null;
  return (
    <p aria-hidden="true" className="text-sm text-muted-foreground tabular-nums">
      {text}
    </p>
  );
}
