/**
 * F8 Phase 8 T218 — Route-level loading skeleton for `/admin/renewals/tasks`.
 *
 * Mirrors the live 8-column queue table shape (member · tier · expiry ·
 * task type · due_at · assignee · status · actions) per FR-046a +
 * ux-standards.md § 2.1. Plus a filter-bar skeleton above the table so
 * the status tabs + assignment chips + task-type select don't pop in
 * after hydration. CLS=0 invariant: page + loading both wrap in
 * `TableContainer` (enforced by `pnpm check:layout`).
 *
 * Column count MUST match the live table at escalation-task-queue.tsx
 * (8 cols admin / 7 cols manager). pnpm check:layout enforces
 * TableContainer+TableContainer pairing but cannot validate column
 * count — keep them in sync manually when adding/removing columns.
 *
 * R6 IMP-1 close — manager session has 7 cols (no Actions column).
 * Loading skeleton can't read the role at the route level, so we
 * default to 8 (admin envelope) which produces a tiny CLS shrink for
 * managers on hydration. Acceptable per ux-standards.md § 18 because
 * (a) admin is the dominant case, (b) the shrink is one column not a
 * grid resize, and (c) the manager_read_only_notice banner above the
 * table absorbs visual weight on the first paint.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tasks');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {/* sr-only AT announcement (I-22 close — WCAG 4.1.3 Status Messages) */}
      <p className="sr-only" role="status" aria-live="polite">
        {t('loading')}
      </p>
      {/* Filter-bar skeleton — 3 status tabs + 3 assignment chips +
          task-type select. Mirrors the live filter row at
          `escalation-task-queue.tsx:240-286`. */}
      <div
        className="mb-4 flex flex-wrap items-center gap-2"
        aria-hidden
      >
        <div className="flex gap-1">
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-9 w-20" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-9 w-12" />
          <Skeleton className="h-9 w-14" />
          <Skeleton className="h-9 w-24" />
        </div>
        <Skeleton className="ml-auto h-9 w-32" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-8 gap-4 border-b py-2" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
            <div className="flex justify-end gap-2">
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-8 gap-4 py-2"
              aria-hidden
            >
              {Array.from({ length: 7 }).map((_, colIdx) => (
                <Skeleton key={colIdx} className="h-5 w-full" />
              ))}
              <div className="flex justify-end gap-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-16" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </TableContainer>
  );
}
