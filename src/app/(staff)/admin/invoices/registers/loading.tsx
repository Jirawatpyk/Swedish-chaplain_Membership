/**
 * /admin/invoices/registers loading skeleton.
 *
 * Spec 122 US8c (T846) — the `Admin-invoice-registers` shape on AURA, for
 * CLS 0: the header with Back to invoices, the register form row, the period
 * output VAT box, the summary line, then AURA's own DataTable skeleton with
 * the real columns (cards below 640px), in a card that drops its frame on a
 * phone.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import {
  TAX_REGISTER_COLUMN_LAYOUT,
  type TaxRegisterColumnKey,
} from './_components/tax-register-table-columns';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.registers');
  const tLayout = await getTranslations('layout');
  const columns = (Object.keys(TAX_REGISTER_COLUMN_LAYOUT) as TaxRegisterColumnKey[]).map((key) => ({
    key,
    label: t(`columns.${key}`),
    ...TAX_REGISTER_COLUMN_LAYOUT[key],
  }));
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('description')}
          actions={<SkeletonBlock className="h-[var(--aura-button-height)] w-36" />}
        />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
            {/* The register form — register, From, To, View register. */}
            <div className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2 lg:grid-cols-[18rem_12rem_12rem_auto] lg:items-end">
              <SkeletonBlock className="h-[calc(var(--aura-input-height)+1.5rem)] w-full sm:col-span-2 lg:col-span-1" />
              <SkeletonBlock className="h-[calc(var(--aura-input-height)+1.5rem)] w-full" />
              <SkeletonBlock className="h-[calc(var(--aura-input-height)+1.5rem)] w-full" />
              <SkeletonBlock className="h-[var(--aura-button-height)] w-32" />
            </div>
            {/* The period output VAT box. */}
            <SkeletonBlock className="h-56 w-full rounded-[var(--aura-radius-lg)]" />
            {/* The summary line. */}
            <SkeletonBlock className="h-4 w-96 max-w-full" />
            <DataTableSkeleton label={t('title')} columns={columns} rows={10} />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
