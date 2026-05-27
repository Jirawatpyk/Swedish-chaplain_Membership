/**
 * Route-level loading UI for /admin/audit — shimmer skeleton in the final
 * table shape for CLS 0 (ux-standards § 2.1). Mirrors the audit viewer layout:
 * header + export action, the filter bar, and a 6-column audit table.
 */
import { getTranslations } from 'next-intl/server';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const SKELETON_ROWS = Array.from({ length: 8 }, (_, i) => i);

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.audit');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<Skeleton className="h-9 w-28" />}
      />

      {/* Filter bar — event-type select + actor + target + from + to */}
      <FilterBar aria-hidden>
        <Skeleton className="h-9 sm:w-64" />
        <Skeleton className="h-9 sm:w-56" />
        <Skeleton className="h-9 sm:w-48" />
        <Skeleton className="h-9 sm:w-40" />
        <Skeleton className="h-9 sm:w-40" />
      </FilterBar>

      <div className="overflow-x-auto rounded-md border" aria-hidden>
        <div className="min-w-full divide-y">
          {/* header row */}
          <div className="flex gap-4 p-3">
            {['w-32', 'w-40', 'w-32', 'w-24', 'w-48', 'w-40'].map((w, i) => (
              <Skeleton key={`${w}-${i}`} className={`h-4 ${w}`} />
            ))}
          </div>
          {SKELETON_ROWS.map((i) => (
            <div key={i} className="flex gap-4 p-3">
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-48" />
              <Skeleton className="h-9 w-40" />
            </div>
          ))}
        </div>
      </div>
    </TableContainer>
  );
}
