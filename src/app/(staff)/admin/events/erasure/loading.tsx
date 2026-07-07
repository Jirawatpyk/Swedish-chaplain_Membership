/**
 * F6 remediation PR 2.2 / P4 — erase-by-email page shimmer skeleton.
 *
 * Renders inside TableContainer + PageHeader (real header text, per the
 * admin-loading convention) so the layout matches the real page on navigation
 * and `pnpm check:layout` accepts the container pair.
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default async function EraseByEmailLoading() {
  const t = await getTranslations('admin.events.erasure');
  return (
    <TableContainer aria-busy="true">
      <PageHeader title={t('pageTitle')} subtitle={t('pageHint')} />
      <Card aria-hidden>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Skeleton className="h-11 min-w-[16rem] flex-1" />
            <Skeleton className="h-11 w-28" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
