/**
 * T046 (F6.1 · Feature 013 — Phase 5 US5) — history page skeleton.
 *
 * Spec 122 US9b-2 (T938): the real page's shape on AURA for CLS 0 — the
 * header (real title, subtitle and the back action), the polling row, the
 * table's header band and rows, and the pagination row. Uses the SAME
 * `TableContainer` as page.tsx (`pnpm check:layout` invariant).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';

// ux I1 (R1 — enterprise-ux-designer): 10 rows match the viewport-visible
// count for a 30-row page so the skeleton ⇄ real-data swap minimises CLS.
const SKELETON_ROW_COUNT = 10;

export default async function CsvImportHistoryLoading() {
  const t = await getTranslations('admin.events.import.history');
  const tLayout = await getTranslations('layout');
  // The table's own columns (widths and card roles as in
  // `csv-import-history-table.tsx`), so the swap to data does not shift.
  const columns = [
    { key: 'uploadedAtDisplay', label: t('columns.uploadedAt'), width: 176, card: 'hide' as const },
    { key: 'originalFilename', label: t('columns.file'), card: 'title' as const },
    { key: 'sourceFormat', label: t('columns.sourceFormat'), width: 128, card: 'hide' as const },
    { key: 'outcome', label: t('columns.outcome'), width: 144, card: 'pill' as const },
    { key: 'processed', label: t('columns.rowsProcessed'), width: 104 },
    { key: 'skipped', label: t('columns.rowsSkipped'), width: 96, card: 'hide' as const },
    { key: 'failed', label: t('columns.rowsFailed'), width: 88, card: 'hide' as const },
    { key: 'actions', label: t('columns.actions'), card: 'hide' as const },
  ];
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader
          title={t('pageTitle')}
          subtitle={t('pageSubtitle')}
          actions={<SkeletonBlock className="h-[var(--aura-button-height)] w-36 max-lg:hidden" />}
        />
        {/* The list-card rule, as the page draws it. */}
        <Card flushBelow="sm" className="overflow-hidden max-sm:border-0 max-sm:p-0 sm:pt-0">
          <div className="flex flex-col gap-[var(--aura-space-3)]">
            <DataTableSkeleton
              label={t('tableAriaLabel')}
              columns={columns}
              rows={SKELETON_ROW_COUNT}
            />
            <div aria-hidden className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
              <SkeletonBlock className="h-4 w-40" />
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
