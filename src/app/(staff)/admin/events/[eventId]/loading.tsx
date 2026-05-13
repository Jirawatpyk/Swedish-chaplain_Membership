/**
 * T066 — /admin/events/[eventId] detail page shimmer skeleton (F6 Phase 4).
 */
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventDetailLoading() {
  // R6-W11 staff-review fix (2026-05-13): wrap all skeleton groups
  // in `aria-hidden` so the shimmer rectangles are not exposed as
  // discrete elements. The Skeleton nested inside the PageHeader
  // `<h1>` slot is wrapped in a `<span aria-hidden>` to avoid
  // VoiceOver announcing "heading level 1" with no accessible name.
  // R7-A + R7-B staff-review fix (2026-05-13): (a) `<span
  // className="block">` — default-inline `<span>` does not
  // establish a block formatting context, so the inner block-
  // display Skeleton (`h-7`) could collapse to 0 height on some
  // browsers. (b) `aria-busy="true"` on the container — the
  // comment above had previously claimed this but the JSX did not
  // actually set it, so AT users got silence instead of the
  // promised "busy" signal.
  return (
    <DetailContainer aria-busy="true">
      <PageHeader
        title={<span aria-hidden="true" className="block"><Skeleton className="h-7 w-72" /></span>}
        subtitle={<Skeleton className="h-4 w-48" aria-hidden />}
      />
      <Card aria-hidden>
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
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-2">
          <Skeleton className="h-9 flex-1 max-w-md" />
          <Skeleton className="h-9 w-44" />
        </div>
        <div className="flex flex-col gap-2">
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
