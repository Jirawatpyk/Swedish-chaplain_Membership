/**
 * Route-level loading UI for /admin/invoices/registers (088 T065b).
 *
 * async + translated title/subtitle mirror the sibling `page.tsx` PageHeader
 * shape so the shell does not shift when the register renders. Uses the same
 * `TableContainer` as the page (check:layout requires a matching container).
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.registers');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Register picker skeleton — mirrors <TaxRegisterForm /> (kind
              select + two date inputs + a View button). aria-hidden so the
              placeholder stays out of the a11y tree. */}
          <div
            className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end"
            aria-hidden
          >
            <Skeleton className="h-9 sm:w-[18rem]" />
            <Skeleton className="h-9 sm:w-40" />
            <Skeleton className="h-9 sm:w-40" />
            <Skeleton className="h-9 w-28" />
          </div>
          {/* Summary + table skeleton. */}
          <Skeleton className="h-5 w-2/3" aria-hidden />
          <div className="flex flex-col gap-2" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
