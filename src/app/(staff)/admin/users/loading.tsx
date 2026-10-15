import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';

/**
 * Loading skeleton must mirror the real page layout 1:1 for CLS 0:
 *   - PageHeader with "Invite user" action button (right-aligned)
 *   - Filter row: search, Role and Status filters, the count
 *   - Table (5 columns × 8 rows), edge to edge in the card; cards below 640px
 *   - Pagination summary + nav row
 *
 * Spec 122 US10a (T1006): on AURA — the page's AURA card, which drops its
 * frame below 640px as the page does, and AURA's own table skeleton with the
 * real column names.
 */
export default async function Loading() {
  const t = await getTranslations('admin.users');
  const tLayout = await getTranslations('layout');
  const columns = (['email', 'name', 'role', 'status', 'actions'] as const).map((key) => ({
    key,
    label: t(`columns.${key}`),
  }));
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader
          title={t('title')}
          subtitle={t('pageSubtitle')}
          actions={<SkeletonBlock className="h-9 w-28 max-sm:h-11" />}
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The filter row — matches <UsersFilters />: search, Role, Status, the count. */}
            <div aria-hidden data-skeleton="filters" className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-auto sm:min-w-60 sm:flex-1 max-sm:h-11 max-sm:w-auto max-sm:min-w-0 max-sm:flex-1 max-sm:basis-0" data-skeleton="search" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-28 max-sm:h-11 sm:hidden" data-skeleton="filters-button" />
              <SkeletonBlock className="h-8 w-28 max-sm:hidden" data-skeleton="filter-select" />
              <SkeletonBlock className="h-8 w-32 max-sm:hidden" data-skeleton="filter-select" />
              <SkeletonBlock className="ml-auto h-4 w-16" data-skeleton="result-count" />
            </div>
            <DataTableSkeleton label={t('title')} columns={columns} rows={8} />
            {/* Pagination row — "Showing X–Y of Z" + page nav */}
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between" aria-hidden>
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-9 w-56" />
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
