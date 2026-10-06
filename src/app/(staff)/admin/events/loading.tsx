/**
 * T065 — /admin/events list page skeleton (F6 Phase 4).
 *
 * Spec 122 US9a (T901): the real page's shape on AURA for CLS 0 — the header
 * (real title and subtitle; the action is a placeholder), then the list card
 * with the filter row (search, three toggle chips, the count) and AURA's own
 * table in its loading state with the real columns, edge to edge in the card,
 * cards below 640px (`DataTableSkeleton`).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import { EVENTS_LIST_COLUMN_LAYOUT, type EventsListColumnKey } from '@/components/events/events-list-columns';

export default async function EventsListLoading() {
  const t = await getTranslations('admin.events.list');
  const tLayout = await getTranslations('layout');
  const columns = (Object.keys(EVENTS_LIST_COLUMN_LAYOUT) as EventsListColumnKey[]).map((key) => ({
    key,
    label: t(`columns.${key}`),
    ...EVENTS_LIST_COLUMN_LAYOUT[key],
  }));
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} actions={<SkeletonBlock className="h-9 w-32" />} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The filter row: the search, three toggle chips, the count. */}
            <div aria-hidden data-skeleton="filters" className="flex flex-wrap items-center gap-2">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-auto sm:min-w-60 sm:flex-1" />
              <SkeletonBlock className="h-8 w-44 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="h-8 w-44 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="h-8 w-40 rounded-full" data-skeleton="toggle-chip" />
              <SkeletonBlock className="ml-auto h-4 w-20" data-skeleton="result-count" />
            </div>
            <DataTableSkeleton label={t('tableCaption')} columns={columns} rows={8} />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
