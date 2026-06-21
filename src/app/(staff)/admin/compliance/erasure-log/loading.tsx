/**
 * Route-level loading UI for /admin/compliance/erasure-log — shimmer skeleton
 * in the final shape for CLS 0 (ux-standards § 2.1). Mirrors the evidence-log
 * layout: PageHeader + a list of card skeletons (header row with a status
 * badge + a sectioned definition grid), inside a TableContainer to match the
 * page's container (check:layout pairing).
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

function EvidenceCardSkeleton(): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-6 w-24 rounded-4xl" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Two sectioned definition grids. */}
        {[0, 1].map((s) => (
          <div key={s} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.compliance.erasureLog');
  return (
    <TableContainer aria-busy="true">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden>
        <EvidenceCardSkeleton />
        <EvidenceCardSkeleton />
      </div>
    </TableContainer>
  );
}
