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
  // R6-W11 staff-review fix (2026-05-13): wrap Skeleton inside the
  // PageHeader `<h1>` slot in `<span aria-hidden>` so VoiceOver does
  // not announce "heading level 1" with no label. Card carries
  // `aria-hidden` for the same reason as the detail loading skeleton.
  // R7-A staff-review fix (2026-05-13): `<span className="block">` —
  // a default-inline span does not establish a block formatting
  // context, so the inner block-display Skeleton (`h-7`) could
  // collapse to 0 height on some browsers. Forcing block restores
  // CLS-0 layout intent.
  return (
    <TableContainer aria-busy="true">
      <PageHeader
        title={<span aria-hidden="true" className="block"><Skeleton className="h-7 w-44" /></span>}
        subtitle={<Skeleton className="h-4 w-64" aria-hidden />}
        // "Import CSV" CTA in PageHeader actions — admin-only button
        // rendered by the real page. Skeleton placeholder keeps CLS-0
        // when the page swaps in.
        actions={<Skeleton className="h-9 w-32 rounded-lg" aria-hidden />}
      />
      <Card aria-hidden>
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
