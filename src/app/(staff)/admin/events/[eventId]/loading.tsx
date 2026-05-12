/**
 * T066 — /admin/events/[eventId] detail page shimmer skeleton (F6 Phase 4).
 */
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventDetailLoading() {
  return (
    <DetailContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-72" />}
        subtitle={<Skeleton className="h-4 w-48" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-64" />
              <Skeleton className="h-4 w-48" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-28" />
              </div>
            </div>
            <Skeleton className="h-9 w-40" />
          </div>
          <div className="flex gap-6 border-t pt-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-40" />
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-9 flex-1 max-w-md" />
          <Skeleton className="h-9 w-44" />
        </div>
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="grid grid-cols-5 gap-3 border-b bg-muted/40 px-4 py-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-full" />
            ))}
          </div>
          {Array.from({ length: 10 }).map((_, r) => (
            <div
              key={r}
              className="grid grid-cols-5 gap-3 border-b px-4 py-3 last:border-b-0"
            >
              {Array.from({ length: 5 }).map((__, c) => (
                <Skeleton key={c} className="h-5 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </DetailContainer>
  );
}
