/**
 * Shimmer skeleton matching the timeline page shape for CLS 0
 * transitions. Used by `/admin/members/[memberId]/timeline/loading.tsx`.
 *
 * Structure mirrors the real timeline page BODY (the enclosing
 * DetailContainer owns section-gap spacing):
 *   - PageHeader — uses the real primitive so the typography, sizing,
 *     and absence-of-border exactly match the hydrated page.
 *   - Company name card header + total-events caption on the right.
 *   - Vertical list of 5 event rows mirrors `<TimelineEventItem>`.
 *
 * Returns a Fragment, not a wrapping <div>, so the parent
 * `DetailContainer`'s `flex flex-col gap-[var(--page-section-gap)]`
 * owns the spacing between PageHeader and Card.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/page-header';

function TimelineEventSkeleton() {
  return (
    <li className="relative border-l-2 border-muted pl-6 py-3">
      {/* Matches the real TimelineEventItem source marker (24px circle at
          -left-[13px]) so skeleton→content is CLS-free (review-run R2-3). */}
      <span
        aria-hidden
        className="absolute -left-[13px] top-4 size-6 rounded-full border bg-background"
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
    <>
      <PageHeader
        title={<Skeleton className="h-7 w-36" />}
        subtitle={<Skeleton className="h-4 w-52" />}
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card aria-hidden>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-40" />
          </CardTitle>
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col">
            {Array.from({ length: 5 }).map((_, i) => (
              <TimelineEventSkeleton key={i} />
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
