/**
 * Route-level loading UI for /admin/invoices.
 *
 * async + translated title/subtitle match the pattern used by members,
 * plans, and settings/invoicing. An older sync version was observed to
 * bubble up to the parent /admin/loading.tsx (dashboard skeleton) under
 * Next.js 16 Cache Components because the boundary did not resolve
 * its i18n in time with the async page.
 *
 * Spec 122 US8 (T806, T809) — the `Admin-invoices` shape on AURA, for CLS 0:
 * "New invoice" in the header (the one action every admin gets; a manager or
 * a tenant without registers gets fewer, never more), the filter row, the
 * count line, then AURA's own DataTable skeleton with the real columns
 * (Invoice No. · Buyer · Status · Due · Receipt No. · Total · Actions), which
 * becomes cards below 640px like the real table, in a card that drops its
 * frame on a phone. The Queue and Method columns are opt-in views a
 * route-level boundary cannot read, so they are not reserved.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { InvoicesTableSkeleton } from './_components/invoices-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.list');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('description')}
          actions={<SkeletonBlock className="h-[var(--aura-button-height)] w-32" />}
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
            {/* The filter row — search, then the status / type / document filters. */}
            <div className="flex flex-wrap gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full sm:w-64" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-36" />
            </div>
            {/* "{n} invoices · to see drafts, choose Draft in the Status filter" */}
            <SkeletonBlock className="h-4 w-64" />
            <InvoicesTableSkeleton
              caption={t('tableCaption')}
              labels={{
                documentNumber: t('columns.documentNumber'),
                memberName: t('columns.buyer'),
                status: t('columns.status'),
                dueDate: t('columns.dueDate'),
                receipt: t('columns.receiptNumber'),
                total: t('columns.total'),
                actions: t('columns.actions'),
              }}
            />
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
