/**
 * Route-level loading UI for /admin/audit — shimmer skeleton in the final
 * shape for CLS 0 (ux-standards § 2.1). Mirrors the audit viewer layout: header +
 * export action, the Card-wrapped filter bar + 6-column audit table (via
 * `AuditTableSkeleton`).
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { AuditTableSkeleton } from '@/components/audit/audit-table-skeleton';

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.audit');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<Skeleton className="h-9 w-28" />}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar — event-type select + actor + target + from + to */}
          <FilterBar aria-hidden>
            <Skeleton className="h-9 sm:w-64" />
            <Skeleton className="h-9 sm:flex-1" />
            <Skeleton className="h-9 sm:flex-1" />
            <Skeleton className="h-9 sm:w-40" />
            <Skeleton className="h-9 sm:w-40" />
          </FilterBar>
          <AuditTableSkeleton />
        </CardContent>
      </Card>
    </TableContainer>
  );
}
