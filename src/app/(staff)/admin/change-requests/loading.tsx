/**
 * Route-level loading UI for /admin/change-requests — header + the filter
 * bar's shape + five rows of AURA's table (same TableContainer as page.tsx per
 * check:layout, CLS 0 — the shape is the page's, not a generic list), in
 * the page's one list card (the list card rule, spec 122 US8a).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { QueueTableSkeleton } from './_components/queue-table-skeleton';

/** The queue table's columns, in `queue-table.tsx` order. */
const COLUMN_KEYS = ['member', 'submitter', 'fields', 'submitted', 'waiting', 'status', 'actions'] as const;

export default async function Loading() {
  const t = await getTranslations('admin.changeRequests.queue');
  const tLayout = await getTranslations('layout');
  return (
    // announced (PR-1 review, UX M4 — the plain aria-hidden skeleton said nothing)
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-4">
            {/* the filter row (the filter pattern): the Status and Submitted
                faces, the count at the end; Outcome exists only under Decided */}
            <div className="flex flex-wrap items-center gap-2" aria-hidden="true" data-skeleton="filters">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" data-skeleton="filter-face" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-44" data-skeleton="filter-face" />
              <SkeletonBlock className="ml-auto h-4 w-32" data-skeleton="result-count" />
            </div>
            {/* AURA's table with the queue's heads, edge to edge inside the card. */}
            <QueueTableSkeleton
              caption={t('tableCaption')}
              heads={COLUMN_KEYS.map((key) => t(`columns.${key}`))}
              rows={5}
            />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
