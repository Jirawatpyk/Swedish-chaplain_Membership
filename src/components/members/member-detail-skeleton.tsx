/**
 * Shimmer skeleton matching the member detail page shape for CLS 0
 * transitions. Used by `/admin/members/[memberId]/loading.tsx` so the
 * fallback doesn't inherit the parent segment's table skeleton.
 *
 * Structure mirrors the real detail page BODY (the route `loading.tsx`
 * owns the `<PageHeader>` shell + its action-button skeletons):
 *   - Company card: dt/dd grid (3 cols on lg) with ~13 fields
 *   - Contacts heading
 *   - Primary contact card: 4-field dl grid
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
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Card>
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

      <Skeleton className="mt-4 h-5 w-24" />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-48" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <DlRowSkeleton key={i} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
