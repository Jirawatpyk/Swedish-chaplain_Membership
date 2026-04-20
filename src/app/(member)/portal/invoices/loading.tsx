import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * R7-B3 — /portal/invoices loading skeleton.
 *
 * Mirrors the real table: 6 columns × 5 rows placeholder. Real
 * translated title + subtitle (not skeletons) to match the settled
 * page header, per the project convention (see
 * /admin/settings/invoicing/loading.tsx).
 */
export default async function Loading() {
  const t = await getTranslations('portal.invoices');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <TableContainer>
        <PageHeader title={t('title')} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* Reserve InvoiceFilters shape: search input (flex-1) +
                status select (12rem) — keeps CLS-0 when real form
                paints. */}
            <div className="flex flex-wrap items-end gap-3">
              <SkeletonBlock className="h-9 flex-1 min-w-[10rem]" />
              <SkeletonBlock className="h-9 w-[12rem]" />
            </div>
            <div className="grid grid-cols-6 gap-3">
              {Array.from({ length: 6 }).map((_, c) => (
                <SkeletonBlock key={c} className="h-4 w-20" />
              ))}
            </div>
            {Array.from({ length: 5 }).map((_, r) => (
              <div key={r} className="grid grid-cols-6 gap-3">
                {Array.from({ length: 6 }).map((_, c) => (
                  <SkeletonBlock key={c} className="h-8 w-full" />
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
