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

export function MonthFilterChip({ monthLabel }: { readonly monthLabel: string }) {
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
      document.getElementById('renewals-by-month')?.focus();
    });
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm">
      <span>{t('filterChip', { month: monthLabel })}</span>
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
