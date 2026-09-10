/**
 * Admin /admin/broadcasts loading skeleton.
 *
 * Renders the real PageHeader (static i18n, no broadcast data needed)
 * + body skeletons. Header doesn't flash between skeleton and final
 * state.
 *
 * A4 UX hardening — layout mirrors the real surface so CLS is minimal.
 *
 * Round 4 D11 — that sentence was ahead of the code. The chip COUNT was derived
 * and correct, and the HEIGHT was not: the real bar has a `<legend>` above the
 * chips and a `<Label>` above each of the three controls, none of which the
 * skeleton drew, so the bar grew by about one label line on hydration and the
 * table jumped. Label placeholders added. Still not measured in a browser —
 * "minimal" here means the boxes match, not that CLS was observed.
 *
 * What it mirrors:
 *   - SLA banner placeholder (h-16)
 *   - Filter bar: one chip placeholder per `OFFERED_BROADCAST_STATUSES`
 *     entry + member-select + 2 date inputs (matches `queue-filters.tsx`
 *     flex-wrap layout, which renders one chip per OFFERED status — Task 3
 *     fix: this used to hardcode 8, drifting from the 10-entry
 *     `BROADCAST_STATUSES` tuple after the F7.1a Phase 3 B0 extension)
 *
 *     Round 2 R2-23 — and then it drifted the OTHER way: 108 Phase 9 withheld
 *     two retired statuses from the real strip, and this kept reserving 10 for a
 *     row of 8. Both surfaces now read the same derived tuple, so the count
 *     cannot disagree again.
 *   - Table: header row + 6 body rows
 *
 * Bulk-action bar is omitted intentionally — it only renders when the
 * admin selects ≥1 row, so reserving space pre-data would itself cause
 * CLS once data lands with zero selections.
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { OFFERED_BROADCAST_STATUSES } from '@/modules/broadcasts';

export default async function AdminBroadcastsLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {/* SLA banner placeholder */}
      <Skeleton className="h-16 w-full" aria-hidden="true" />
      {/* Filter bar: one status chip per OFFERED status + member combobox + date×2 */}
      <div
        className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3"
        aria-hidden="true"
      >
        {/*
          Round 4 D11 — each control gets its LABEL line too.
          The real bar renders a `<legend>` above the chip row and a `<Label>`
          above the member select and both date inputs; the skeleton had neither,
          so the bar grew by about one label line the moment data landed and the
          table below it jumped. The docblock on this file already claimed "layout
          mirrors the real surface so CLS is minimal", which made the gap look
          settled — the chip COUNT was fixed and the height was not.
        */}
        <div className="flex flex-col gap-1">
          <Skeleton className="h-5 w-16" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: OFFERED_BROADCAST_STATUSES.length }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-24 rounded-full" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-56" />
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-40" />
        </div>
      </div>
      {/* Table: header + 6 rows */}
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </TableContainer>
  );
}
