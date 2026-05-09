/**
 * F8 Phase 8 T218 — Route-level loading skeleton for `/admin/renewals/tasks`.
 *
 * Mirrors the live 6-column queue table shape (member · task type ·
 * due_at · assignee · status · actions) per FR-046a + ux-standards.md
 * § 2.1. CLS=0 invariant: page + loading both wrap in `TableContainer`
 * (enforced by `pnpm check:layout`).
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
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-6 gap-4 border-b py-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
          {Array.from({ length: 10 }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-6 gap-4 py-2"
              aria-hidden
            >
              {Array.from({ length: 5 }).map((_, colIdx) => (
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
