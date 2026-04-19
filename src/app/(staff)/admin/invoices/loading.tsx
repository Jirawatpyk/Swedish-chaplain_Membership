import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function Loading() {
  return (
    <TableContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-32" />}
        subtitle={<Skeleton className="h-4 w-64" />}
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar skeleton — mirrors <InvoiceFilters /> */}
          <div className="flex flex-wrap items-end gap-3">
            <Skeleton className="h-10 flex-1 min-w-[16rem]" />
            <Skeleton className="h-10 w-[12rem]" />
          </div>
          {/* Table rows skeleton */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          {/* Pagination summary skeleton */}
          <div className="flex justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-9 w-48" />
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
