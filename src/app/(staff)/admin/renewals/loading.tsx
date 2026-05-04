/**
 * F8 Phase 3 Wave H4 · T068 — Route-level loading skeleton for
 * `/admin/renewals`. Matches final table shape (CLS=0 per FR-046a +
 * docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<TableContainer>` so `pnpm check:layout` invariant
 * (page+loading both use the same variant) holds.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.renewals');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Filter row — matches page.tsx layout: 8 urgency tabs +
              tier filter select. Stacks on mobile, row on sm+. */}
          <div
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            aria-hidden
          >
            <div className="flex gap-1.5 overflow-x-auto">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-20 shrink-0" />
              ))}
            </div>
            <Skeleton className="h-9 w-full sm:w-56" />
          </div>
          {/* Table header placeholder */}
          <div className="grid grid-cols-8 gap-4 border-b py-2" aria-hidden>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
          {/* 10 row placeholders */}
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-8 gap-4 py-2"
              aria-hidden
            >
              {Array.from({ length: 8 }).map((_, colIdx) => (
                <Skeleton key={colIdx} className="h-5 w-full" />
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </TableContainer>
  );
}
