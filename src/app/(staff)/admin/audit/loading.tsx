/**
 * Route-level loading UI for /admin/audit, in the final shape for CLS 0:
 * header + export action, then the list card with the filter row, the
 * 6-column audit table and the retention line.
 *
 * Spec 122 US10b (T1013): on AURA — the page's AURA card, which drops its
 * frame below 640px as the page does, and AURA's own table skeleton with the
 * real column names.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { AuditTableSkeleton } from '@/components/audit/audit-table-skeleton';

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.audit');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={<SkeletonBlock className="h-9 w-32 max-sm:h-11" />}
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          {/* AURA wraps the children of a Card in its body, so the spacing lives on this wrapper. */}
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The filter row — matches <AuditFilters />: the target search, Event type, Date, More filters, the count. */}
            <div aria-hidden data-skeleton="filters" className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-auto sm:min-w-60 sm:flex-1" />
              <SkeletonBlock className="h-8 w-40" data-skeleton="filter-select" />
              <SkeletonBlock className="h-8 w-28" data-skeleton="filter-select" />
              <SkeletonBlock className="h-8 w-28" data-skeleton="filter-select" />
              <SkeletonBlock className="ml-auto h-4 w-20" data-skeleton="result-count" />
            </div>
            <AuditTableSkeleton
              labels={{
                caption: t('table.caption'),
                time: t('table.time'),
                event: t('table.event'),
                actor: t('table.actor'),
                target: t('table.target'),
                summary: t('table.summary'),
                payload: t('table.payload'),
              }}
            />
            <SkeletonBlock aria-hidden className="h-4 w-72 max-w-full" />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
