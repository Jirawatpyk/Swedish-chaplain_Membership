/**
 * Route-level loading UI for /admin/invoices.
 *
 * async + translated title/subtitle match the pattern used by members,
 * plans, and settings/invoicing. An older sync version was observed to
 * bubble up to the parent /admin/loading.tsx (dashboard skeleton) under
 * Next.js 16 Cache Components because the boundary did not resolve
 * its i18n in time with the async page.
 *
 * Spec 122 US8 (T806) — the `Admin-invoices` shape on AURA, for CLS 0: the
 * header's actions, the filter row, the count line, then the seven-column
 * table (Invoice No. · Buyer · Status · Due · Receipt No. · Total · Actions)
 * in a card that drops its frame on a phone. The Queue and Method columns are
 * opt-in views a route-level boundary cannot read, so they are not reserved.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock, TableSkeleton } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.list');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('description')}
          actions={
            <>
              <SkeletonBlock className="h-9 w-28" />
              <SkeletonBlock className="h-9 w-28" />
              <SkeletonBlock className="h-9 w-32" />
            </>
          }
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
            {/* The filter row — search, then the status / type / document filters. */}
            <div className="flex flex-wrap gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-[var(--input-height)] w-full sm:w-64" />
              <SkeletonBlock className="h-[var(--input-height)] w-36" />
              <SkeletonBlock className="h-[var(--input-height)] w-36" />
              <SkeletonBlock className="h-[var(--input-height)] w-36" />
            </div>
            {/* "{n} invoices · drafts are under Status → Draft" */}
            <SkeletonBlock className="h-4 w-64" />
            <TableSkeleton columns={7} rows={8} />
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
