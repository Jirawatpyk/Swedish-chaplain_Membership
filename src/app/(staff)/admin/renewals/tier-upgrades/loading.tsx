/**
 * F8 Phase 7 review-fix C-UX-1 — Route-level loading skeleton for
 * `/admin/renewals/tier-upgrades`. Mirrors the final 6-column table
 * shape (CLS=0 per FR-046a + docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<TableContainer>` so `pnpm check:layout` invariant
 * (page + loading both use the same variant) holds. Sister route at
 * `/admin/renewals/loading.tsx` follows the same pattern.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Table header placeholder — 6 cols match the live queue:
              member · from-plan · to-plan · reason · status · actions */}
          <div className="grid grid-cols-6 gap-4 border-b py-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
          {/* 10 row placeholders */}
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-6 gap-4 py-2"
              aria-hidden
            >
              {Array.from({ length: 5 }).map((_, colIdx) => (
                <Skeleton key={colIdx} className="h-5 w-full" />
              ))}
              {/* Last col mimics the 3 action buttons */}
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
