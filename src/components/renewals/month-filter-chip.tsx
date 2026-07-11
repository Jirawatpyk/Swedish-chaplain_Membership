/**
 * Renewals-by-month — dismissible "Renewing in {month}" chip (client).
 *
 * Shown when a `?month` filter is active. The ✕ is a real button that clears
 * `?month` + `?cursor` (soft-nav) and returns focus to the chart region so
 * keyboard focus is never lost after the row unmounts (WCAG 2.4.3).
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

export interface MonthFilterChipProps {
  /** Discriminates the dedicated overdue/later/concrete-month chip copy. */
  readonly monthKind: 'overdue' | 'later' | 'month';
  /** Bare month text — omitted for `overdue` (no month to show). */
  readonly monthLabel?: string;
}

export function MonthFilterChip({ monthKind, monthLabel }: MonthFilterChipProps) {
  const t = useTranslations('admin.renewals.byMonth');
  const router = useRouter();
  const params = useSearchParams();

  function clear() {
    const next = new URLSearchParams(params.toString());
    next.delete('month');
    next.delete('cursor');
    next.delete('nowIso'); // drop the pagination-session anchor (leaves with cursor)
    const qs = next.toString();
    router.push(qs ? `/admin/renewals?${qs}` : '/admin/renewals');
    // Return focus to the chart region (its row link unmounts on clear).
    requestAnimationFrame(() => {
      // Best-effort focus-restore: if the section re-rendered into its
      // error branch before this callback runs (narrow paint race),
      // `#renewals-by-month` won't exist — fall back to the layout's
      // `#main-content` landmark (focusable via tabIndex=-1, same
      // fallback pattern used by the broadcast dialogs' final-focus
      // resolver) so focus doesn't silently drop to <body> (WCAG 2.4.3).
      const region = document.getElementById('renewals-by-month');
      if (region) {
        region.focus();
      } else {
        document.getElementById('main-content')?.focus?.();
      }
    });
  }

  const chipText =
    monthKind === 'overdue'
      ? t('filterChipOverdue')
      : monthKind === 'later' && monthLabel !== undefined
        ? t('filterChipLater', { month: monthLabel })
        : monthLabel !== undefined
          ? t('filterChip', { month: monthLabel })
          : '';

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm">
      <span>{chipText}</span>
      <button
        type="button"
        onClick={clear}
        aria-label={t('clearFilter')}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}
