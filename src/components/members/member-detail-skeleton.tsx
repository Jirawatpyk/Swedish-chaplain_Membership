/**
 * Shimmer skeleton matching the member detail page shape for CLS 0
 * transitions. Used by `/admin/members/[memberId]/loading.tsx` so the
 * fallback doesn't inherit the parent segment's table skeleton.
 *
 * Structure mirrors the real detail page BODY (the route `loading.tsx`
 * owns the `<PageHeader>` shell + its action-button skeletons), 056 "C"
 * layout after polish FIX 2:
 *   - Company Card (full width): dt/dd grid (3 cols on lg)
 *   - 2-col row (lg+, reflows to 1-col below lg): Renewal&Health | Benefits
 *   - Contacts Card (full width)
 *   - Invoices Card (full width)
 *   - Timeline Card (full width)
 *   - DataExport Card (full width, F9-gated — skeleton always present;
 *     real section is rendered server-side with its own Suspense boundary)
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
      {/* Company card — full width. */}
      <Card aria-hidden>
        <CardHeader>
          <CardTitle className="text-base">
            <Skeleton className="h-4 w-20" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <DlRowSkeleton key={i} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 2-col row: Renewal & Health | Benefits (reflows to 1-col below lg).
          Matches the showBenefitsPreview branch of the real page. */}
      <div className="grid grid-cols-1 items-start gap-[var(--page-section-gap)] lg:grid-cols-2">
        {/* Left col: Renewal & Health card (status + expiry + at-risk band). */}
        <Card aria-hidden>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-24" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <DlRowSkeleton key={i} />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Right col: Benefits preview card (quota bars + "Full benefits →" link). */}
        <Card aria-hidden>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-24" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-2 w-full rounded-full" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Contacts — full-width below the 2-col row.
          Matches the real page order after the 056 polish reorder. */}
      <Card aria-hidden>
        <CardHeader className="flex flex-row items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-8 w-28" />
        </CardHeader>
        <CardContent>
          {/* Primary contact block — name row + 4-field grid. */}
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

      {/* Invoices + Timeline — full width. */}
      {Array.from({ length: 2 }).map((_, i) => (
        <Card aria-hidden key={i}>
          <CardHeader className="flex flex-row items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-24" />
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((__, r) => (
                <Skeleton key={r} className="h-5 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  );
}
