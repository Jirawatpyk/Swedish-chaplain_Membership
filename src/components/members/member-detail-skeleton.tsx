/**
 * Shimmer skeleton matching the member detail page shape for CLS 0
 * transitions. Used by `/admin/members/[memberId]/loading.tsx` so the
 * fallback doesn't inherit the parent segment's table skeleton.
 *
 * Structure mirrors the real detail page BODY (the route `loading.tsx`
 * owns the `<PageHeader>` shell + its action-button skeletons):
 *   - Company Card: dt/dd grid (3 cols on lg) with ~13 fields
 *   - Contacts Card: single outer card with CardTitle + one primary
 *     contact block inside (name header row + 4-field dl grid). Matches
 *     the real page where individual contacts are flat rows inside the
 *     outer card, separated by <Separator /> — no nested cards.
 */

import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function DlRowSkeleton() {
  return (
    <div className="flex flex-col gap-1 py-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-4 w-32" />
    </div>
  );
}

export function MemberDetailSkeleton() {
  // Fragment (not wrapping <div>) — the enclosing DetailContainer
  // supplies `flex flex-col gap-[var(--page-section-gap)]`. Wrapping
  // here would collapse the gap into a single wrapper child.
  return (
    <>
      <Card aria-hidden>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-20" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 13 }).map((_, i) => (
              <DlRowSkeleton key={i} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card aria-hidden>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-24" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* One flat primary-contact block — name row + 4-field grid.
              No nested card shell; parent CardContent owns the framing. */}
          <div className="mb-3 flex flex-row items-start justify-between gap-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-28" />
          </div>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <DlRowSkeleton key={i} />
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
