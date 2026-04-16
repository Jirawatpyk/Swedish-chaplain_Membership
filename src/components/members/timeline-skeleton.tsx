/**
 * Shimmer skeleton matching the timeline page shape for CLS 0
 * transitions. Used by `/admin/members/[memberId]/timeline/loading.tsx`.
 *
 * Structure mirrors the real timeline page:
 *   - Header row: title + subtitle + Back action button
 *   - Company name card header
 *   - Vertical list of 5 event rows (mirrors `<TimelineEventItem>`)
 */

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function TimelineEventSkeleton() {
  return (
    <li className="relative border-l-2 border-muted pl-6 py-3">
      <span
        aria-hidden
        className="absolute -left-[5px] top-5 h-2 w-2 rounded-full bg-muted"
      />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-24" />
      </div>
    </li>
  );
}

export function TimelineSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {/* Header row mirrors <PageHeader /> with one Back action */}
      <div className="flex flex-col gap-2 pb-4 border-b md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-52" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-40" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col">
            {Array.from({ length: 5 }).map((_, i) => (
              <TimelineEventSkeleton key={i} />
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
