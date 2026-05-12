/**
 * T065 — /admin/events list page shimmer skeleton (F6 Phase 4).
 *
 * CLS-0 shape — mirrors EventsListTable's 6-column header + 8 row
 * shape exactly. Renders inside TableContainer + PageHeader so the
 * layout matches the real page on navigation.
 */
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventsListLoading() {
  return (
    <TableContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-44" />}
        subtitle={<Skeleton className="h-4 w-64" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-2" aria-hidden>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-32" />
            ))}
          </div>
          <div className="flex flex-col gap-2" aria-hidden>
            <div className="grid grid-cols-6 gap-3 border-b bg-muted/40 px-4 py-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
            {Array.from({ length: 8 }).map((_, r) => (
              <div
                key={r}
                className="grid grid-cols-6 gap-3 border-b px-4 py-3 last:border-b-0"
              >
                {Array.from({ length: 6 }).map((__, c) => (
                  <Skeleton key={c} className="h-5 w-full" />
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
