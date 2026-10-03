/**
 * /admin/credit-notes directory loading skeleton.
 *
 * Spec 122 US8c (T844) — the `Admin-credit-notes` shape on AURA, for CLS 0:
 * the header, the filter row (search, fiscal year), then AURA's own DataTable
 * skeleton with the real columns (Number · Issued · Original tax invoice ·
 * Member · Reason · Total · PDF), which becomes cards below 640px like the
 * real table, in a card that drops its frame on a phone.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import {
  CREDIT_NOTES_COLUMN_LAYOUT,
  type CreditNotesColumnKey,
} from './_components/credit-notes-table-columns';

export default async function Loading() {
  const t = await getTranslations('admin.creditNotes.list');
  const tLayout = await getTranslations('layout');
  const columns = (Object.keys(CREDIT_NOTES_COLUMN_LAYOUT) as CreditNotesColumnKey[]).map((key) => ({
    key,
    label: t(`columns.${key}`),
    ...CREDIT_NOTES_COLUMN_LAYOUT[key],
  }));
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('description')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
            {/* The filter row — search, then the fiscal year. */}
            <div className="flex flex-wrap gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:flex-1" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" />
            </div>
            <DataTableSkeleton label={t('tableCaption')} columns={columns} rows={8} />
            <div className="flex justify-between">
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="h-9 w-48" />
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
